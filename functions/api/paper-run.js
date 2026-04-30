import {
  buildHistoricalEdgeGate,
  ensureArchiveColumns
} from "../_shared/archive-intelligence.js";

import {
  applyFtmoGuardianToScans
} from "../_shared/ftmo-guardian.js";

import {
  applyNewsFilterToScans
} from "../_shared/news-filter.js";

import {
  buildRealisticEntry,
  buildRealisticExit
} from "../_shared/realistic-execution.js";

const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

const MODEL_VERSION = "server-paper-v10-realistic-news-ftmo-safe";
const DEFAULT_TIMEFRAME = "M15";
const CANDLE_LIMIT = 260;
const MAX_OPEN_TRADES = 4;
const MIN_ULTRA_SCORE = 72;
const MIN_ENTRY_QUALITY = 68;
const EXPLORATION_MIN_ULTRA_SCORE = 60;
const EXPLORATION_MIN_ENTRY_QUALITY = 58;

const FRESHNESS_SECONDS = {
  M5: 60 * 60,
  M15: 3 * 60 * 60,
  H1: 8 * 60 * 60,
  H4: 24 * 60 * 60
};

export async function onRequestGet(context) {
  return handlePaperRun(context);
}

export async function onRequestPost(context) {
  return handlePaperRun(context);
}

async function handlePaperRun(context) {
  const startedAt = Date.now();

  try {
    const env = context.env || {};
    const db = env.DB;
    const secret = env.SYNC_SECRET || "";

    if (!db) {
      return json({ ok: false, error: "Missing DB binding" }, 500);
    }

    if (!isAuthorized(context.request, secret)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    await ensurePaperTables(db);
    await ensureArchiveColumns(db);
    await ensurePaperColumns(db);

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    const timeframe =
      normalizeTimeframe(url.searchParams.get("timeframe") || body.timeframe) ||
      DEFAULT_TIMEFRAME;

    const account = buildPaperAccountConfig(env, {
      startingBalance:
        url.searchParams.get("startingBalance") ||
        body.startingBalance ||
        env.FTMO_STARTING_BALANCE
    });

    const dryRun = String(url.searchParams.get("dryRun") || body.dryRun || "0") === "1";

    const rawMarketScans = await scanAllPairs(db, timeframe);

    const historicalScans = await Promise.all(
      rawMarketScans.map(async (scan) => {
        if (!scan || scan.signal === "WAIT") return scan;

        const historical = await buildHistoricalEdgeGate(db, {
          ...scan,
          session: inferSession(new Date()),
          hour: inferHour(new Date())
        }, {
          mode: "learning"
        });

        const adjustedPaperScore = Math.round(
          Number(scan.paperScore || 0) * 0.78 +
          Number(historical.edgeScore || 50) * 0.22
        );

        const allowedByHistory = historical.learningAllowed !== false;

        return {
          ...scan,
          historicalEdge: historical,
          historicalEdgeScore: historical.edgeScore,
          historicalConfidence: historical.confidence,
          paperScore: adjustedPaperScore,
          tradeAllowed: Boolean(scan.tradeAllowed && allowedByHistory),
          tradeReason: scan.tradeAllowed && !allowedByHistory
            ? `Historical edge blocked: ${historical.reason}`
            : `${scan.tradeReason || "Accepted"} Historical: ${historical.reason}`
        };
      })
    );

    const newsFilteredScans = await applyNewsFilterToScans(db, historicalScans, {
      env,
      timeframe,
      mode: "paper"
    });

    const marketScans = await applyFtmoGuardianToScans(db, newsFilteredScans, {
      env,
      timeframe,
      mode: "paper"
    });

    const openBefore = await getOpenTrades(db, timeframe);

    const closed = dryRun
      ? []
      : await closeOrManageTrades(db, timeframe, openBefore, marketScans, account, env);

    const openAfterClose = dryRun
      ? openBefore
      : await getOpenTrades(db, timeframe);

    const opened = dryRun
      ? []
      : await openNewTrades(db, timeframe, openAfterClose, marketScans, account, env);

    const durationMs = Date.now() - startedAt;

    if (!dryRun) {
      await insertPaperRun(db, {
        timeframe,
        scannedPairs: marketScans.length,
        opened: opened.length,
        closed: closed.length,
        notes: `${MODEL_VERSION}; duration=${durationMs}ms; account=${account.startingBalance}`
      });
    }

    return json({
      ok: true,
      source: "paper-run",
      version: MODEL_VERSION,
      dryRun,
      timeframe,
      account: {
        phase: account.phase,
        startingBalance: account.startingBalance,
        maxTradeRiskPercent: account.maxTradeRiskPercent,
        maxOpenRiskPercent: account.maxOpenRiskPercent,
        dailyLossLimitPercent: account.dailyLossLimitPercent,
        maxLossLimitPercent: account.maxLossLimitPercent
      },
      scannedPairs: marketScans.length,
      opened: opened.length,
      closed: closed.length,
      openBefore: openBefore.length,
      openAfter: openAfterClose.length + opened.length,
      durationMs,
      topCandidates: marketScans
        .slice()
        .sort((a, b) => Number(b.paperScore || 0) - Number(a.paperScore || 0))
        .slice(0, 12)
        .map((scan) => ({
          pair: scan.pair,
          timeframe: scan.timeframe,
          signal: scan.signal,
          direction: scan.direction,
          current: scan.current,
          stopLoss: scan.stopLoss,
          takeProfit: scan.takeProfit,
          tp1: scan.tp1,
          rr: scan.rr,

          ultraScore: scan.ultraScore,
          trendScore: scan.trendScore,
          timingScore: scan.timingScore,
          riskScore: scan.riskScore,
          executionScore: scan.executionScore,
          smartMoneyScore: scan.smartMoneyScore,
          entryQualityScore: scan.entryQualityScore,
          setupQualityScore: scan.setupQualityScore,
          exitPressureScore: scan.exitPressureScore,
          paperScore: scan.paperScore,

          historicalEdgeScore: scan.historicalEdgeScore,
          historicalConfidence: scan.historicalConfidence,

          setupType: scan.setupType,
          setupLabel: scan.setupLabel,
          volatilityRegime: scan.volatilityRegime,
          trendRegime: scan.trendRegime,

          newsAllowed: scan.newsAllowed,
          newsRiskLevel: scan.newsRiskLevel,
          newsReason: scan.newsReason,

          tradeAllowed: scan.tradeAllowed,
          tradeStatus: scan.tradeStatus,
          tradeReason: scan.tradeReason,

          ftmoAllowed: scan.ftmoAllowed,
          ftmoStatus: scan.ftmoStatus,
          ftmoRecommendedRiskPercent: scan.ftmoRecommendedRiskPercent,
          ftmoRecommendedRiskAmount: scan.ftmoRecommendedRiskAmount,
          ftmoReason: scan.ftmoReason
        })),
      opened,
      closed
    });
  } catch (error) {
    return json({
      ok: false,
      source: "paper-run",
      version: MODEL_VERSION,
      error: String(error?.message || error || "paper-run-error")
    }, 500);
  }
}

async function ensurePaperTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS paper_open_trades (
      id TEXT PRIMARY KEY,
      pair TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      direction TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      entry REAL NOT NULL,
      stop_loss REAL NOT NULL,
      take_profit REAL NOT NULL,
      current_price REAL,
      risk_percent REAL,
      rr REAL,
      bars_held INTEGER,
      max_bars_hold INTEGER,
      ultra_score REAL,
      ml_score REAL,
      archive_edge_score REAL,
      session TEXT,
      hour INTEGER,
      model_tag TEXT,
      source TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id TEXT PRIMARY KEY,
      pair TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      direction TEXT NOT NULL,
      opened_at TEXT,
      closed_at TEXT,
      entry REAL,
      exit REAL,
      stop_loss REAL,
      take_profit REAL,
      pnl REAL,
      pnl_r REAL,
      win INTEGER,
      session TEXT,
      hour INTEGER,
      ultra_score REAL,
      ml_score REAL,
      vectorbt_score REAL,
      archive_edge_score REAL,
      close_reason TEXT,
      source TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS paper_runs (
      id TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL,
      timeframe TEXT,
      scanned_pairs INTEGER,
      opened INTEGER,
      closed INTEGER,
      notes TEXT
    )
  `).run();
}

async function ensurePaperColumns(db) {
  const openColumns = [
    ["setup_type", "TEXT"],
    ["setup_quality_score", "REAL"],
    ["entry_quality_score", "REAL"],
    ["exit_pressure_score", "REAL"],
    ["volatility_regime", "TEXT"],
    ["trend_regime", "TEXT"],
    ["sniper_score", "REAL"]
  ];

  const closedColumns = [
    ["setup_type", "TEXT"],
    ["setup_quality_score", "REAL"],
    ["entry_quality_score", "REAL"],
    ["exit_pressure_score", "REAL"],
    ["volatility_regime", "TEXT"],
    ["trend_regime", "TEXT"],
    ["model_tag", "TEXT"],
    ["sniper_score", "REAL"],
    ["close_reason", "TEXT"],
    ["source", "TEXT"],
    ["archive_edge_score", "REAL"],
    ["vectorbt_score", "REAL"],
    ["ml_score", "REAL"]
  ];

  for (const [name, type] of openColumns) {
    await addColumnIfMissing(db, "paper_open_trades", name, type);
  }

  for (const [name, type] of closedColumns) {
    await addColumnIfMissing(db, "paper_trades", name, type);
  }
}

async function addColumnIfMissing(db, table, column, type) {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch {
    // Column already exists.
  }
}

async function scanAllPairs(db, timeframe) {
  const scans = [];

  for (const pair of PAIRS) {
    const candles = await getCandles(db, pair, timeframe);
    const freshness = getFreshness(candles, timeframe);

    if (candles.length < 60) {
      scans.push(buildEmptyScan(pair, timeframe, candles, "Not enough candles"));
      continue;
    }

    if (!freshness.fresh) {
      scans.push(buildEmptyScan(pair, timeframe, candles, `Stale candles: ${freshness.ageMinutes} min old`));
      continue;
    }

    const archive = await getArchiveStats(db, pair, timeframe);
    const scan = buildScan(pair, timeframe, candles, archive, freshness);

    scans.push(scan);
  }

  return scans;
}

async function getCandles(db, pair, timeframe) {
  const res = await db
    .prepare(`
      SELECT ts, open, high, low, close
      FROM market_candles
      WHERE pair = ?
        AND timeframe = ?
      ORDER BY ts DESC
      LIMIT ?
    `)
    .bind(pair, timeframe, CANDLE_LIMIT)
    .all();

  const rows = Array.isArray(res.results) ? res.results : [];

  return rows
    .map((row) => ({
      time: Number(row.ts || 0),
      open: Number(row.open || 0),
      high: Number(row.high || 0),
      low: Number(row.low || 0),
      close: Number(row.close || 0)
    }))
    .filter((candle) =>
      Number.isFinite(candle.time) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      candle.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

async function getArchiveStats(db, pair, timeframe) {
  try {
    const row = await db
      .prepare(`
        SELECT
          COUNT(*) AS trades,
          SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
          ROUND(AVG(pnl_r), 4) AS expectancy,
          ROUND(SUM(pnl_r), 4) AS pnl_r
        FROM paper_trades
        WHERE pair = ?
          AND timeframe = ?
      `)
      .bind(pair, timeframe)
      .first();

    const buy = await db
      .prepare(`
        SELECT
          COUNT(*) AS trades,
          SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
          ROUND(AVG(pnl_r), 4) AS expectancy
        FROM paper_trades
        WHERE pair = ?
          AND timeframe = ?
          AND direction = 'buy'
      `)
      .bind(pair, timeframe)
      .first();

    const sell = await db
      .prepare(`
        SELECT
          COUNT(*) AS trades,
          SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
          ROUND(AVG(pnl_r), 4) AS expectancy
        FROM paper_trades
        WHERE pair = ?
          AND timeframe = ?
          AND direction = 'sell'
      `)
      .bind(pair, timeframe)
      .first();

    return {
      trades: Number(row?.trades || 0),
      wins: Number(row?.wins || 0),
      winRate: Number(row?.trades || 0)
        ? Number(((Number(row?.wins || 0) / Number(row?.trades || 0)) * 100).toFixed(2))
        : 50,
      expectancy: Number(row?.expectancy || 0),
      pnlR: Number(row?.pnl_r || 0),
      directions: {
        buy: normalizeDirectionStats(buy),
        sell: normalizeDirectionStats(sell)
      }
    };
  } catch {
    return {
      trades: 0,
      wins: 0,
      winRate: 50,
      expectancy: 0,
      pnlR: 0,
      directions: {
        buy: { trades: 0, wins: 0, winRate: 50, expectancy: 0 },
        sell: { trades: 0, wins: 0, winRate: 50, expectancy: 0 }
      }
    };
  }
}

function normalizeDirectionStats(row) {
  const trades = Number(row?.trades || 0);
  const wins = Number(row?.wins || 0);

  return {
    trades,
    wins,
    winRate: trades ? Number(((wins / trades) * 100).toFixed(2)) : 50,
    expectancy: Number(row?.expectancy || 0)
  };
}

function buildEmptyScan(pair, timeframe, candles, reason) {
  return {
    pair,
    timeframe,
    candles,
    current: Number(candles.at(-1)?.close || 0),
    direction: "wait",
    signal: "WAIT",
    tradeAllowed: false,
    tradeStatus: "NO DATA",
    tradeReason: reason,
    ultraScore: 0,
    entryQualityScore: 0,
    setupQualityScore: 0,
    exitPressureScore: 99,
    paperScore: 0,
    stopLoss: 0,
    takeProfit: 0,
    tp1: 0,
    rr: getDefaultRr(pair),
    setupType: "weak-signal",
    setupLabel: "Weak signal",
    volatilityRegime: "unknown",
    trendRegime: "unknown"
  };
}

function buildScan(pair, timeframe, candles, archive, freshness) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const current = closes.at(-1);
  const previous = closes.at(-2) || current;

  const ema20Value = ema(closes, 20);
  const ema50Value = ema(closes, 50);
  const ema100Value = ema(closes, 100);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(highs, lows, closes, 14);
  const momentum = computeMomentum(closes, 12);
  const volatility = computeVolatility(closes, 30);
  const macdLine = ema(closes, 12) - ema(closes, 26);

  const direction = getDirection({
    current,
    ema20Value,
    ema50Value,
    momentum,
    rsi14
  });

  const signal =
    direction === "buy" ? "BUY" :
    direction === "sell" ? "SELL" :
    "WAIT";

  const trendScore = computeTrendScore({
    current,
    ema20Value,
    ema50Value,
    ema100Value,
    momentum,
    direction
  });

  const timingScore = computeTimingScore({
    rsi14,
    macdLine,
    momentum,
    current,
    previous,
    direction
  });

  const riskScore = computeRiskScore(pair, volatility, atr14, current);
  const sessionScore = computeSessionScore(pair);
  const executionScore = computeExecutionScore(candles, direction, atr14);
  const smartMoneyScore = computeSmartMoneyScore(candles, direction);
  const archiveScore = computeArchiveScore(archive, direction);

  const setup = classifySetup({
    pair,
    candles,
    current,
    direction,
    atr14,
    volatility
  });

  const rr = getDefaultRr(pair);
  const riskDistance = computeRiskDistance(pair, current, atr14);

  const stopLoss =
    direction === "sell"
      ? current + riskDistance
      : current - riskDistance;

  const takeProfit =
    direction === "sell"
      ? current - riskDistance * rr
      : current + riskDistance * rr;

  const tp1 =
    direction === "sell"
      ? current - riskDistance * 1.05
      : current + riskDistance * 1.05;

  const ultraScore = clamp(
    trendScore * 0.20 +
      timingScore * 0.15 +
      riskScore * 0.10 +
      executionScore * 0.14 +
      smartMoneyScore * 0.10 +
      sessionScore * 0.06 +
      archiveScore * 0.10 +
      setup.setupQualityScore * 0.15,
    1,
    99
  );

  const entry = computeEntryQualityScore({
    pair,
    current,
    direction,
    signal,
    ultraScore,
    trendScore,
    timingScore,
    riskScore,
    executionScore,
    smartMoneyScore,
    archiveScore,
    setupQualityScore: setup.setupQualityScore,
    setupType: setup.setupType,
    wickRiskScore: setup.wickRiskScore,
    distanceEma20Atr: setup.distanceEma20Atr,
    lateImpulse: setup.lateImpulse,
    rsi14
  });

  const exitPressure = computeExitPressureScore({
    pair,
    signal,
    ultraScore,
    trendScore,
    timingScore,
    riskScore,
    executionScore,
    smartMoneyScore,
    archiveScore,
    setupType: setup.setupType,
    volatilityRegime: setup.volatilityRegime,
    wickRiskScore: setup.wickRiskScore,
    lateImpulse: setup.lateImpulse,
    momentum,
    volatility
  });

  const lateEntry = Boolean(setup.lateImpulse);

  const archiveBad =
    archive.trades >= 12 &&
    archive.expectancy < -0.25 &&
    getDirectionArchive(archive, direction).expectancy < -0.18;

  const tradeAllowed =
    signal !== "WAIT" &&
    ultraScore >= MIN_ULTRA_SCORE &&
    entry.score >= MIN_ENTRY_QUALITY &&
    setup.setupQualityScore >= 66 &&
    exitPressure.score < 68 &&
    !lateEntry &&
    !archiveBad &&
    riskScore >= 42 &&
    setup.setupType !== "weak-signal" &&
    setup.setupType !== "late-impulse" &&
    setup.volatilityRegime !== "extreme";

  const paperScore = computePaperCandidateScore({
    ultraScore,
    entryQualityScore: entry.score,
    setupQualityScore: setup.setupQualityScore,
    exitPressureScore: exitPressure.score,
    archiveScore,
    executionScore,
    smartMoneyScore,
    riskScore,
    sessionScore
  });

  return {
    pair,
    timeframe,
    candles,
    rowCount: candles.length,
    fresh: true,
    candleAgeMinutes: freshness.ageMinutes,

    current: roundByPair(current, pair),
    direction,
    signal,

    ultraScore: Math.round(ultraScore),
    trendScore: Math.round(trendScore),
    timingScore: Math.round(timingScore),
    riskScore: Math.round(riskScore),
    sessionScore: Math.round(sessionScore),
    executionScore: Math.round(executionScore),
    smartMoneyScore: Math.round(smartMoneyScore),
    archiveEdgeScore: Math.round(archiveScore),

    setupType: setup.setupType,
    setupLabel: setup.setupLabel,
    setupQualityScore: setup.setupQualityScore,
    setupStrength: setup.setupStrength,
    volatilityRegime: setup.volatilityRegime,
    trendRegime: setup.trendRegime,
    triggerType: setup.triggerType,
    entryModel: setup.entryModel,
    distanceEma20Atr: setup.distanceEma20Atr,
    wickRiskScore: setup.wickRiskScore,
    lateImpulse: setup.lateImpulse,

    entryQualityScore: entry.score,
    entryQualityLabel: entry.label,
    entryQualityReasons: entry.reasons,

    exitPressureScore: exitPressure.score,
    exitPressureLabel: exitPressure.label,

    rsi14: round(rsi14, 2),
    atr14: roundByPair(atr14, pair),
    momentum: round(momentum, 3),
    volatility: round(volatility, 6),

    rr,
    stopLoss: roundByPair(stopLoss, pair),
    takeProfit: roundByPair(takeProfit, pair),
    tp1: roundByPair(tp1, pair),

    tradeAllowed,
    tradeStatus: tradeAllowed ? "VALID FTMO-CANDIDATE" : "BLOCKED",
    tradeReason: tradeAllowed
      ? `${setup.setupLabel} accepted by paper gate.`
      : buildBlockReason({
          signal,
          ultraScore,
          entryQualityScore: entry.score,
          setupQualityScore: setup.setupQualityScore,
          exitPressureScore: exitPressure.score,
          lateEntry,
          archiveBad,
          riskScore,
          setupType: setup.setupType,
          volatilityRegime: setup.volatilityRegime
        }),

    archive,
    paperScore: Math.round(paperScore)
  };
}

async function getOpenTrades(db, timeframe) {
  try {
    const res = await db
      .prepare(`
        SELECT
          id,
          pair,
          timeframe,
          direction,
          opened_at,
          entry,
          stop_loss,
          take_profit,
          current_price,
          risk_percent,
          rr,
          bars_held,
          max_bars_hold,
          ultra_score,
          ml_score,
          archive_edge_score,
          session,
          hour,
          model_tag,
          source,
          setup_type,
          setup_quality_score,
          entry_quality_score,
          exit_pressure_score,
          volatility_regime,
          trend_regime,
          sniper_score
        FROM paper_open_trades
        WHERE timeframe = ?
        ORDER BY opened_at DESC
      `)
      .bind(timeframe)
      .all();

    return Array.isArray(res.results) ? res.results.map(normalizeOpenTrade) : [];
  } catch {
    return [];
  }
}

function normalizeOpenTrade(row) {
  return {
    id: row.id,
    pair: String(row.pair || "").toUpperCase(),
    timeframe: normalizeTimeframe(row.timeframe) || DEFAULT_TIMEFRAME,
    direction: String(row.direction || "buy").toLowerCase(),
    openedAt: row.opened_at,
    entry: Number(row.entry || 0),
    stopLoss: Number(row.stop_loss || 0),
    takeProfit: Number(row.take_profit || 0),
    currentPrice: Number(row.current_price || row.entry || 0),
    riskPercent: Number(row.risk_percent || 0.25),
    rr: Number(row.rr || getDefaultRr(row.pair)),
    barsHeld: Number(row.bars_held || 0),
    maxBarsHold: Number(row.max_bars_hold || 12),
    ultraScore: Number(row.ultra_score || 0),
    mlScore: Number(row.ml_score || 50),
    archiveEdgeScore: Number(row.archive_edge_score || 50),
    session: row.session || "OffSession",
    hour: Number(row.hour || 0),
    modelTag: row.model_tag || "",
    source: row.source || "server-paper",
    setupType: row.setup_type || extractSetupTypeFromTag(row.model_tag),
    setupQualityScore: Number(row.setup_quality_score || 0),
    entryQualityScore: Number(row.entry_quality_score || 0),
    exitPressureScore: Number(row.exit_pressure_score || 0),
    volatilityRegime: row.volatility_regime || "unknown",
    trendRegime: row.trend_regime || "unknown",
    sniperScore: Number(row.sniper_score || 0)
  };
}

async function closeOrManageTrades(db, timeframe, openTrades, scans, account, env) {
  const closed = [];

  for (const trade of openTrades) {
    const scan = scans.find((item) => item.pair === trade.pair);

    if (!scan || !scan.current) {
      await updateOpenTrade(db, {
        ...trade,
        barsHeld: trade.barsHeld + 1,
        currentPrice: trade.currentPrice
      });
      continue;
    }

    const management = manageOpenTrade(trade, scan);

    if (management.close) {
      const closedTrade = buildClosedTrade(trade, scan, management, account, env);

      await insertClosedTrade(db, closedTrade);
      await deleteOpenTrade(db, trade.id);

      closed.push(closedTrade);
    } else {
      await updateOpenTrade(db, {
        ...trade,
        stopLoss: management.nextStopLoss,
        currentPrice: scan.current,
        barsHeld: trade.barsHeld + 1,
        ultraScore: scan.ultraScore,
        archiveEdgeScore: scan.archiveEdgeScore
      });
    }
  }

  return closed;
}

function manageOpenTrade(trade, scan) {
  const direction = String(trade.direction || "buy").toLowerCase();
  const entry = Number(trade.entry || 0);
  const price = Number(scan.current || 0);
  const activeStop = Number(trade.stopLoss || 0);
  const target = Number(trade.takeProfit || 0);
  const originalRisk = getOriginalRiskDistance(trade);

  const livePnlR = computeLivePnlR(trade, price);
  const exitPressure = computeExitPressureScore(scan, trade, livePnlR);

  if (direction === "buy") {
    if (price <= activeStop) {
      return {
        close: true,
        reason: "active-stop",
        exitPrice: activeStop,
        pnlR: computePnlR(trade, activeStop)
      };
    }

    if (price >= target) {
      return {
        close: true,
        reason: "take-profit",
        exitPrice: target,
        pnlR: computePnlR(trade, target)
      };
    }
  }

  if (direction === "sell") {
    if (price >= activeStop) {
      return {
        close: true,
        reason: "active-stop",
        exitPrice: activeStop,
        pnlR: computePnlR(trade, activeStop)
      };
    }

    if (price <= target) {
      return {
        close: true,
        reason: "take-profit",
        exitPrice: target,
        pnlR: computePnlR(trade, target)
      };
    }
  }

  if (trade.barsHeld >= trade.maxBarsHold) {
    return {
      close: true,
      reason: "time-exit",
      exitPrice: price,
      pnlR: computePnlR(trade, price)
    };
  }

  if (Number(scan.ultraScore || 0) < 50 && livePnlR < 0.35) {
    return {
      close: true,
      reason: "signal-decay",
      exitPrice: price,
      pnlR: computePnlR(trade, price)
    };
  }

  const tradeSignal = direction === "sell" ? "SELL" : "BUY";
  const scanSignal = String(scan.signal || "WAIT").toUpperCase();

  if (
    livePnlR < 0.75 &&
    (
      (tradeSignal === "BUY" && scanSignal === "SELL") ||
      (tradeSignal === "SELL" && scanSignal === "BUY")
    )
  ) {
    return {
      close: true,
      reason: "opposite-signal",
      exitPrice: price,
      pnlR: computePnlR(trade, price)
    };
  }

  if (Number(exitPressure.score || 0) >= 84) {
    return {
      close: true,
      reason: "exit-pressure",
      exitPrice: price,
      pnlR: computePnlR(trade, price)
    };
  }

  let nextStopLoss = activeStop;

  if (livePnlR >= 0.65 && originalRisk > 0) {
    const breakEvenStop =
      direction === "buy"
        ? entry + originalRisk * 0.03
        : entry - originalRisk * 0.03;

    nextStopLoss = improveStop(direction, nextStopLoss, breakEvenStop);
  }

  if (livePnlR >= 1.05 && originalRisk > 0) {
    const lockedR =
      livePnlR >= 2.2 ? 1.45 :
      livePnlR >= 1.65 ? 0.95 :
      0.42;

    const trailStop =
      direction === "buy"
        ? entry + originalRisk * lockedR
        : entry - originalRisk * lockedR;

    nextStopLoss = improveStop(direction, nextStopLoss, trailStop);
  }

  return {
    close: false,
    nextStopLoss: roundByPair(nextStopLoss, trade.pair),
    livePnlR,
    exitPressureScore: exitPressure.score
  };
}

async function openNewTrades(db, timeframe, openTrades, scans, account, env) {
  const opened = [];

  if (openTrades.length >= MAX_OPEN_TRADES) {
    return opened;
  }

  const openPairs = new Set(openTrades.map((trade) => trade.pair));
  const currentRiskGroups = buildRiskGroupsFromTrades(openTrades);

  const candidates = scans
    .filter((scan) => scan.tradeAllowed)
    .filter((scan) => scan.newsAllowed !== false)
    .filter((scan) => scan.ftmoAllowed !== false)
    .filter((scan) => scan.direction === "buy" || scan.direction === "sell")
    .filter((scan) => !openPairs.has(scan.pair))
    .filter((scan) => !wouldOverloadRiskGroup(scan.pair, currentRiskGroups))
    .sort((a, b) => Number(b.paperScore || 0) - Number(a.paperScore || 0));

  for (const scan of candidates) {
    if (openTrades.length + opened.length >= MAX_OPEN_TRADES) break;

    const simulatedGroups = buildRiskGroupsFromTrades([
      ...openTrades,
      ...opened
    ]);

    if (wouldOverloadRiskGroup(scan.pair, simulatedGroups)) {
      continue;
    }

    const trade = createOpenTrade(scan, false, account, env);

    await insertOpenTrade(db, trade);

    opened.push(trade);
    openPairs.add(scan.pair);
  }

  if (!opened.length && openTrades.length === 0) {
    const exploration = scans
      .filter((scan) => !openPairs.has(scan.pair))
      .filter((scan) => scan.newsAllowed !== false)
      .filter((scan) => scan.ftmoAllowed !== false)
      .filter((scan) => scan.direction === "buy" || scan.direction === "sell")
      .filter((scan) => Number(scan.ultraScore || 0) >= EXPLORATION_MIN_ULTRA_SCORE)
      .filter((scan) => Number(scan.entryQualityScore || 0) >= EXPLORATION_MIN_ENTRY_QUALITY)
      .filter((scan) => Number(scan.exitPressureScore || 99) < 72)
      .filter((scan) => !scan.lateImpulse)
      .filter((scan) => scan.setupType !== "weak-signal")
      .filter((scan) => scan.setupType !== "late-impulse")
      .filter((scan) => scan.volatilityRegime !== "extreme")
      .filter((scan) => !wouldOverloadRiskGroup(scan.pair, currentRiskGroups))
      .sort((a, b) => Number(b.paperScore || 0) - Number(a.paperScore || 0))[0];

    if (exploration) {
      const trade = createOpenTrade(exploration, true, account, env);

      await insertOpenTrade(db, trade);

      opened.push(trade);
    }
  }

  return opened;
}

function createOpenTrade(scan, exploration = false, account = {}, env = {}) {
  const now = new Date();

  const realisticEntry = buildRealisticEntry(scan, {
    env
  });

  const guardianRisk = Number(scan.ftmoRecommendedRiskPercent || 0);
  const baseRisk = computeRiskPercent(scan);

  const riskPercent = exploration
    ? Math.min(0.08, guardianRisk || 0.08)
    : Math.min(baseRisk, guardianRisk || baseRisk);

  const maxBarsHold = getMaxBarsHold(scan, exploration);

  return {
    id: `server_paper_${Date.now()}_${scan.pair}_${Math.random().toString(36).slice(2, 8)}`,
    pair: scan.pair,
    timeframe: scan.timeframe,
    direction: scan.direction,
    openedAt: now.toISOString(),

    entry: Number(realisticEntry.entry || scan.current || 0),
    stopLoss: Number(realisticEntry.stopLoss || scan.stopLoss || 0),
    takeProfit: Number(realisticEntry.takeProfit || scan.takeProfit || 0),
    currentPrice: Number(scan.current || 0),

    riskPercent,
    rr: Number(scan.rr || realisticEntry.rr || getDefaultRr(scan.pair)),
    barsHeld: 0,
    maxBarsHold,

    ultraScore: Number(scan.ultraScore || 0),
    mlScore: Number(scan.ultraScore || 50),
    archiveEdgeScore: Number(scan.archiveEdgeScore || scan.historicalEdgeScore || 50),

    setupType: scan.setupType || "unknown",
    setupQualityScore: Number(scan.setupQualityScore || 0),
    entryQualityScore: Number(scan.entryQualityScore || 0),
    exitPressureScore: Number(scan.exitPressureScore || 0),
    volatilityRegime: scan.volatilityRegime || "unknown",
    trendRegime: scan.trendRegime || "unknown",
    sniperScore: Math.max(
      0,
      Number(scan.paperScore || 0) - Number(realisticEntry.executionCostR || 0) * 8
    ),

    session: inferSession(now),
    hour: inferHour(now),

    modelTag: exploration
      ? `SERVER_EXPLORATION_V10_REALISTIC_${scan.pair}_${scan.setupType}_COST${realisticEntry.executionCostR}`
      : `SERVER_V10_REALISTIC_${scan.pair}_${scan.setupType}_COST${realisticEntry.executionCostR}`,

    source: exploration
      ? "server-paper-exploration-v10-realistic"
      : "server-paper-v10-realistic"
  };
}

async function insertOpenTrade(db, trade) {
  await db
    .prepare(`
      INSERT OR REPLACE INTO paper_open_trades (
        id,
        pair,
        timeframe,
        direction,
        opened_at,
        entry,
        stop_loss,
        take_profit,
        current_price,
        risk_percent,
        rr,
        bars_held,
        max_bars_hold,
        ultra_score,
        ml_score,
        archive_edge_score,
        session,
        hour,
        model_tag,
        source,
        setup_type,
        setup_quality_score,
        entry_quality_score,
        exit_pressure_score,
        volatility_regime,
        trend_regime,
        sniper_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      trade.id,
      trade.pair,
      trade.timeframe,
      trade.direction,
      trade.openedAt,
      trade.entry,
      trade.stopLoss,
      trade.takeProfit,
      trade.currentPrice,
      trade.riskPercent,
      trade.rr,
      trade.barsHeld,
      trade.maxBarsHold,
      trade.ultraScore,
      trade.mlScore,
      trade.archiveEdgeScore,
      trade.session,
      trade.hour,
      trade.modelTag,
      trade.source,
      trade.setupType,
      trade.setupQualityScore,
      trade.entryQualityScore,
      trade.exitPressureScore,
      trade.volatilityRegime,
      trade.trendRegime,
      trade.sniperScore
    )
    .run();
}

async function updateOpenTrade(db, trade) {
  await db
    .prepare(`
      UPDATE paper_open_trades
      SET
        stop_loss = ?,
        current_price = ?,
        bars_held = ?,
        ultra_score = ?,
        archive_edge_score = ?
      WHERE id = ?
    `)
    .bind(
      roundByPair(trade.stopLoss, trade.pair),
      roundByPair(trade.currentPrice, trade.pair),
      Number(trade.barsHeld || 0),
      Number(trade.ultraScore || 0),
      Number(trade.archiveEdgeScore || 50),
      trade.id
    )
    .run();
}

async function deleteOpenTrade(db, id) {
  await db.prepare(`DELETE FROM paper_open_trades WHERE id = ?`).bind(id).run();
}

function buildClosedTrade(trade, scan, management, account = {}, env = {}) {
  const realisticExit = buildRealisticExit(trade, management.exitPrice, {
    env
  });

  const pnlR = Number(realisticExit.netPnlR || management.pnlR || 0);
  const grossPnlR = Number(realisticExit.grossPnlR || management.pnlR || 0);

  const startingBalance = Number(account.startingBalance || 10000);
  const riskAmount = startingBalance * (Number(trade.riskPercent || 0.25) / 100);
  const pnl = pnlR * riskAmount;

  return {
    id: trade.id,
    pair: trade.pair,
    timeframe: trade.timeframe,
    direction: trade.direction,
    openedAt: trade.openedAt,
    closedAt: new Date().toISOString(),
    entry: roundByPair(trade.entry, trade.pair),
    exitPrice: roundByPair(realisticExit.exitPrice, trade.pair),
    stopLoss: roundByPair(trade.stopLoss, trade.pair),
    takeProfit: roundByPair(trade.takeProfit, trade.pair),
    pnl: round(pnl, 2),
    pnlR: round(pnlR, 3),
    win: pnlR > 0 ? 1 : 0,
    session: trade.session || inferSession(new Date()),
    hour: Number(trade.hour || inferHour(new Date())),
    ultraScore: Number(scan?.ultraScore || trade.ultraScore || 0),
    mlScore: Number(trade.mlScore || scan?.ultraScore || 50),
    vectorbtScore: Number(scan?.ultraScore || 50),
    archiveEdgeScore: Number(scan?.archiveEdgeScore || trade.archiveEdgeScore || 50),
    setupType: scan?.setupType || trade.setupType || extractSetupTypeFromTag(trade.modelTag),
    setupQualityScore: Number(scan?.setupQualityScore || trade.setupQualityScore || 0),
    entryQualityScore: Number(scan?.entryQualityScore || trade.entryQualityScore || 0),
    exitPressureScore: Number(scan?.exitPressureScore || trade.exitPressureScore || 0),
    volatilityRegime: scan?.volatilityRegime || trade.volatilityRegime || "unknown",
    trendRegime: scan?.trendRegime || trade.trendRegime || "unknown",
    sniperScore: Number(scan?.paperScore || trade.sniperScore || 0),
    modelTag: `${trade.modelTag || ""}_GROSSR${round(grossPnlR, 3)}_NETR${round(pnlR, 3)}_EXECOST${round(realisticExit.executionCostR, 3)}`,
    closeReason: `${management.reason}; realistic-execution-cost-r=${round(realisticExit.executionCostR, 4)}`,
    source: trade.source || "server-paper-v10-realistic"
  };
}

async function insertClosedTrade(db, trade) {
  await db
    .prepare(`
      INSERT OR REPLACE INTO paper_trades (
        id,
        pair,
        timeframe,
        direction,
        opened_at,
        closed_at,
        entry,
        exit,
        stop_loss,
        take_profit,
        pnl,
        pnl_r,
        win,
        session,
        hour,
        ultra_score,
        ml_score,
        vectorbt_score,
        archive_edge_score,
        close_reason,
        source,
        setup_type,
        setup_quality_score,
        entry_quality_score,
        exit_pressure_score,
        volatility_regime,
        trend_regime,
        model_tag,
        sniper_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      trade.id,
      trade.pair,
      trade.timeframe,
      trade.direction,
      trade.openedAt,
      trade.closedAt,
      trade.entry,
      trade.exitPrice,
      trade.stopLoss,
      trade.takeProfit,
      trade.pnl,
      trade.pnlR,
      trade.win,
      trade.session,
      trade.hour,
      trade.ultraScore,
      trade.mlScore,
      trade.vectorbtScore,
      trade.archiveEdgeScore,
      trade.closeReason,
      trade.source,
      trade.setupType,
      trade.setupQualityScore,
      trade.entryQualityScore,
      trade.exitPressureScore,
      trade.volatilityRegime,
      trade.trendRegime,
      trade.modelTag,
      trade.sniperScore
    )
    .run();
}

async function insertPaperRun(db, run) {
  try {
    await db
      .prepare(`
        INSERT INTO paper_runs (
          id,
          ran_at,
          timeframe,
          scanned_pairs,
          opened,
          closed,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        new Date().toISOString(),
        run.timeframe,
        run.scannedPairs,
        run.opened,
        run.closed,
        run.notes
      )
      .run();
  } catch {
    // Optional.
  }
}

function getDirection(data) {
  const bullish =
    data.ema20Value > data.ema50Value &&
    data.current > data.ema20Value &&
    data.momentum > 0 &&
    data.rsi14 >= 45;

  const bearish =
    data.ema20Value < data.ema50Value &&
    data.current < data.ema20Value &&
    data.momentum < 0 &&
    data.rsi14 <= 55;

  if (bullish) return "buy";
  if (bearish) return "sell";
  return "wait";
}

function computeTrendScore(data) {
  let score = 50;

  score += data.ema20Value > data.ema50Value ? 14 : -14;
  score += data.ema50Value > data.ema100Value ? 8 : -8;
  score += data.current > data.ema20Value ? 8 : -8;
  score += data.momentum > 0 ? 10 : -10;

  if (data.direction === "buy" && data.current > data.ema20Value && data.ema20Value > data.ema50Value) score += 8;
  if (data.direction === "sell" && data.current < data.ema20Value && data.ema20Value < data.ema50Value) score += 8;
  if (data.direction === "wait") score -= 8;

  return clamp(score, 1, 99);
}

function computeTimingScore(data) {
  let score = 50;

  score += data.rsi14 >= 43 && data.rsi14 <= 66 ? 14 : -8;
  score += data.macdLine > 0 ? 8 : -8;
  score += data.momentum > 0 ? 8 : -8;
  score += data.current > data.previous ? 5 : -5;

  if (data.direction === "sell") {
    score += data.macdLine < 0 ? 8 : -8;
    score += data.momentum < 0 ? 8 : -8;
    score += data.current < data.previous ? 5 : -5;
  }

  if (data.direction === "wait") score -= 6;

  return clamp(score, 1, 99);
}

function computeRiskScore(pair, volatility, atr14, current) {
  let score = 76;

  score -= Math.min(22, Number(volatility || 0) * 900);

  if (pair === "BTCUSD") score -= 10;
  if (pair === "XAUUSD") score -= 8;
  if (pair.startsWith("GBP")) score -= 2;

  if (atr14 && current) {
    const atrPercent = atr14 / current;

    if (pair === "BTCUSD") {
      if (atrPercent >= 0.002 && atrPercent <= 0.025) score += 6;
      if (atrPercent > 0.045) score -= 12;
    } else if (pair === "XAUUSD") {
      if (atrPercent >= 0.0008 && atrPercent <= 0.015) score += 5;
      if (atrPercent > 0.03) score -= 10;
    } else {
      if (atrPercent >= 0.00025 && atrPercent <= 0.008) score += 5;
      if (atrPercent > 0.018) score -= 10;
    }
  }

  return clamp(score, 1, 99);
}

function computeExecutionScore(candles, direction, atr14) {
  if (candles.length < 30 || direction === "wait") return 50;

  const last = candles.at(-1);
  const prev = candles.at(-2);
  const range = Math.max(0.0000001, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;

  let score = 52;

  if (bodyRatio >= 0.45 && bodyRatio <= 0.82) score += 10;
  if (atr14 > 0 && range <= atr14 * 1.8) score += 8;

  if (direction === "buy") {
    if (last.close > last.open) score += 7;
    if (last.close > prev.high) score += 8;
    if (last.close > last.low + range * 0.68) score += 5;
  }

  if (direction === "sell") {
    if (last.close < last.open) score += 7;
    if (last.close < prev.low) score += 8;
    if (last.close < last.high - range * 0.68) score += 5;
  }

  if (atr14 > 0 && range > atr14 * 2.5) score -= 12;

  return clamp(score, 1, 99);
}

function computeSmartMoneyScore(candles, direction) {
  if (candles.length < 24 || direction === "wait") return 50;

  const recent = candles.slice(-12);
  const previous = candles.slice(-24, -12);
  const last = candles.at(-1);

  const recentRange = average(recent.map((c) => c.high - c.low));
  const previousRange = average(previous.map((c) => c.high - c.low));
  const body = Math.abs(last.close - last.open);
  const range = Math.max(0.0000001, last.high - last.low);
  const bodyRatio = body / range;

  let score = 50;

  if (recentRange > previousRange) score += 8;
  if (bodyRatio >= 0.55) score += 10;
  if (direction === "buy" && last.close > last.open) score += 8;
  if (direction === "sell" && last.close < last.open) score += 8;

  return clamp(score, 1, 99);
}

function computeArchiveScore(archive, direction) {
  const dirStats = getDirectionArchive(archive, direction);

  const confidence =
    archive.trades >= 40 ? 1 :
    archive.trades >= 20 ? 0.82 :
    archive.trades >= 8 ? 0.62 :
    0.4;

  const pairScore =
    scoreWinRate(archive.winRate) * 0.45 +
    scoreExpectancy(archive.expectancy) * 0.55;

  const dirScore =
    scoreWinRate(dirStats.winRate) * 0.45 +
    scoreExpectancy(dirStats.expectancy) * 0.55;

  const raw = pairScore * 0.45 + dirScore * 0.55;

  return clamp(50 + (raw - 50) * confidence, 1, 99);
}

function getDirectionArchive(archive, direction) {
  const dir = direction === "sell" ? "sell" : "buy";

  return archive?.directions?.[dir] || {
    trades: 0,
    wins: 0,
    winRate: 50,
    expectancy: 0
  };
}

function computeEntryQualityScore(data) {
  if (data.direction !== "buy" && data.direction !== "sell") {
    return { score: 0, label: "no-direction", reasons: ["No direction"] };
  }

  let score = 50;
  const reasons = [];

  score += (Number(data.ultraScore || 0) - 70) * 0.18;
  score += (Number(data.setupQualityScore || 50) - 50) * 0.22;
  score += (Number(data.trendScore || 50) - 50) * 0.12;
  score += (Number(data.timingScore || 50) - 50) * 0.14;
  score += (Number(data.executionScore || 50) - 50) * 0.15;
  score += (Number(data.smartMoneyScore || 50) - 50) * 0.09;
  score += (Number(data.archiveScore || 50) - 50) * 0.05;
  score += (Number(data.riskScore || 50) - 50) * 0.05;

  if (data.setupType === "trend-pullback") {
    score += 8;
    reasons.push("Best setup type: trend pullback");
  }

  if (data.setupType === "breakout-continuation") score += 5;
  if (data.setupType === "liquidity-rejection") score += 5;
  if (data.setupType === "momentum-continuation") score += 2;
  if (data.setupType === "range-signal") score -= 8;
  if (data.setupType === "late-impulse") score -= 22;

  if (data.signal === "BUY" || data.signal === "SELL") score += 4;

  if (data.rsi14 > 74 && data.direction === "buy") score -= data.pair === "BTCUSD" ? 10 : 7;
  if (data.rsi14 < 26 && data.direction === "sell") score -= data.pair === "BTCUSD" ? 10 : 7;
  if (data.wickRiskScore >= 65) score -= 8;
  if (data.distanceEma20Atr > 2.2) score -= 7;
  if (data.pair === "BTCUSD") score -= 3;
  if (data.pair === "XAUUSD") score -= 1;

  const finalScore = clamp(score, 1, 99);

  return {
    score: Math.round(finalScore),
    label:
      finalScore >= 84 ? "sniper-entry" :
      finalScore >= 74 ? "clean-entry" :
      finalScore >= 66 ? "acceptable-entry" :
      "weak-entry",
    reasons
  };
}

function computeExitPressureScore(scan, trade = null, livePnlR = 0) {
  let score = 28;

  score += weakness(scan.trendScore, 50) * 0.18;
  score += weakness(scan.timingScore, 48) * 0.16;
  score += weakness(scan.executionScore, 48) * 0.16;
  score += weakness(scan.smartMoneyScore, 48) * 0.10;
  score += weakness(scan.riskScore, 44) * 0.10;
  score += weakness(scan.archiveEdgeScore || scan.archiveScore, 45) * 0.08;

  if (String(scan.signal || "").toUpperCase() === "WAIT") score += 10;
  if (scan.lateImpulse) score += 14;
  if (scan.setupType === "late-impulse") score += 12;
  if (scan.setupType === "range-signal") score += 8;
  if (scan.volatilityRegime === "elevated") score += 6;
  if (scan.volatilityRegime === "extreme") score += 16;
  if (Number(scan.wickRiskScore || 0) >= 65) score += 8;

  if (trade) {
    const direction = String(trade.direction || "").toLowerCase();
    const tradeSignal = direction === "sell" ? "SELL" : "BUY";
    const scanSignal = String(scan.signal || "").toUpperCase();

    if (
      (tradeSignal === "BUY" && scanSignal === "SELL") ||
      (tradeSignal === "SELL" && scanSignal === "BUY")
    ) {
      score += livePnlR < 0.75 ? 18 : 10;
    }
  }

  if (scan.pair === "BTCUSD") {
    if (Number(scan.volatility || 0) > 0.035) score += 12;
    if (Math.abs(Number(scan.momentum || 0)) > 7) score += 8;
  }

  if (scan.pair === "XAUUSD") {
    if (Number(scan.volatility || 0) > 0.025) score += 10;
    if (Math.abs(Number(scan.momentum || 0)) > 3.2) score += 6;
  }

  if (livePnlR >= 1.2 && Number(scan.ultraScore || 0) >= 76) score -= 8;
  if (livePnlR >= 2 && Number(scan.executionScore || 0) >= 62) score -= 6;

  const finalScore = clamp(score, 1, 99);

  return {
    score: Math.round(finalScore),
    label:
      finalScore >= 84 ? "close-pressure" :
      finalScore >= 68 ? "reduce-pressure" :
      finalScore >= 54 ? "trail-pressure" :
      "hold"
  };
}

function classifySetup(input) {
  const pair = String(input.pair || "").toUpperCase();
  const candles = Array.isArray(input.candles) ? input.candles : [];
  const direction = String(input.direction || "wait").toLowerCase();

  if (candles.length < 40 || (direction !== "buy" && direction !== "sell")) {
    return {
      setupType: "weak-signal",
      setupLabel: "Weak signal",
      setupQualityScore: 0,
      setupStrength: "blocked",
      volatilityRegime: "unknown",
      trendRegime: "unknown",
      triggerType: "none",
      entryModel: "none",
      distanceEma20Atr: 0,
      wickRiskScore: 50,
      lateImpulse: false
    };
  }

  const closes = candles.map((c) => Number(c.close || 0)).filter(Number.isFinite);
  const highs = candles.map((c) => Number(c.high || 0)).filter(Number.isFinite);
  const lows = candles.map((c) => Number(c.low || 0)).filter(Number.isFinite);

  const current = Number(input.current || closes.at(-1) || 0);
  const last = candles.at(-1);

  const ema20Value = ema(closes, 20);
  const ema50Value = ema(closes, 50);
  const atrValue = Number(input.atr14 || atr(highs, lows, closes, 14));
  const volatility = Number(input.volatility || computeVolatility(closes, 30));

  const range = Math.max(0.0000001, Number(last.high || 0) - Number(last.low || 0));
  const body = Math.abs(Number(last.close || 0) - Number(last.open || 0));
  const bodyRatio = body / range;

  const upperWick = Number(last.high || 0) - Math.max(Number(last.open || 0), Number(last.close || 0));
  const lowerWick = Math.min(Number(last.open || 0), Number(last.close || 0)) - Number(last.low || 0);

  const upperWickRatio = upperWick / range;
  const lowerWickRatio = lowerWick / range;

  const distanceEma20Atr = atrValue > 0 ? Math.abs(current - ema20Value) / atrValue : 0;
  const atrPercent = current > 0 ? atrValue / current : 0;

  const recent = candles.slice(-12);
  const prevHigh = Math.max(...recent.slice(0, -1).map((c) => Number(c.high || 0)));
  const prevLow = Math.min(...recent.slice(0, -1).map((c) => Number(c.low || 0)));

  const trendUp = ema20Value > ema50Value && current > ema20Value;
  const trendDown = ema20Value < ema50Value && current < ema20Value;

  const trendRegime =
    trendUp ? "uptrend" :
    trendDown ? "downtrend" :
    Math.abs(ema20Value - ema50Value) / Math.max(current, 0.0000001) < 0.0015 ? "range" :
    "mixed";

  const volatilityRegime = getVolatilityRegime(pair, volatility, atrPercent);

  const buyBreakout = direction === "buy" && last.close > prevHigh && last.close > last.open;
  const sellBreakout = direction === "sell" && last.close < prevLow && last.close < last.open;

  const buyPullback =
    direction === "buy" &&
    trendUp &&
    last.low <= ema20Value + atrValue * 0.35 &&
    last.close > ema20Value &&
    last.close > last.open;

  const sellPullback =
    direction === "sell" &&
    trendDown &&
    last.high >= ema20Value - atrValue * 0.35 &&
    last.close < ema20Value &&
    last.close < last.open;

  const buyRejection =
    direction === "buy" &&
    lowerWickRatio >= 0.34 &&
    last.close > last.open &&
    last.close > last.low + range * 0.62;

  const sellRejection =
    direction === "sell" &&
    upperWickRatio >= 0.34 &&
    last.close < last.open &&
    last.close < last.high - range * 0.62;

  const impulseTooLarge = atrValue > 0 && range > atrValue * 2.35;
  const lateImpulse = isLateImpulse(pair, distanceEma20Atr, impulseTooLarge);
  const wickRiskScore = computeWickRiskScore(direction, upperWickRatio, lowerWickRatio, bodyRatio);

  let setupType = "weak-signal";
  let triggerType = "none";
  let entryModel = "none";
  let score = 48;

  if (buyPullback || sellPullback) {
    setupType = "trend-pullback";
    triggerType = "ema-reclaim";
    entryModel = "pullback-confirmation";
    score += 26;
  } else if (buyBreakout || sellBreakout) {
    setupType = "breakout-continuation";
    triggerType = "range-break";
    entryModel = "breakout-confirmation";
    score += 22;
  } else if (buyRejection || sellRejection) {
    setupType = "liquidity-rejection";
    triggerType = "wick-rejection";
    entryModel = "rejection-confirmation";
    score += 20;
  } else if (
    (direction === "buy" && trendUp && bodyRatio >= 0.45) ||
    (direction === "sell" && trendDown && bodyRatio >= 0.45)
  ) {
    setupType = "momentum-continuation";
    triggerType = "momentum-candle";
    entryModel = "momentum-confirmation";
    score += 16;
  } else if (trendRegime === "range") {
    setupType = "range-signal";
    triggerType = "range";
    entryModel = "range-risk";
    score -= 8;
  }

  if (trendRegime === "uptrend" && direction === "buy") score += 7;
  if (trendRegime === "downtrend" && direction === "sell") score += 7;
  if (trendRegime === "mixed") score -= 5;
  if (trendRegime === "range") score -= 8;

  if (bodyRatio >= 0.48 && bodyRatio <= 0.82) score += 7;
  if (wickRiskScore >= 65) score -= 10;

  if (lateImpulse) {
    setupType = "late-impulse";
    triggerType = "late";
    entryModel = "avoid-late-entry";
    score -= 24;
  } else if (distanceEma20Atr <= 1.2) {
    score += 7;
  } else if (distanceEma20Atr <= 2.0) {
    score += 2;
  } else {
    score -= 8;
  }

  if (volatilityRegime === "normal") score += 5;
  if (volatilityRegime === "quiet") score -= 3;
  if (volatilityRegime === "elevated") score -= pair === "BTCUSD" || pair === "XAUUSD" ? 7 : 5;
  if (volatilityRegime === "extreme") score -= 18;

  if (pair === "BTCUSD") score -= 3;
  if (pair === "XAUUSD") score -= 1;

  const setupQualityScore = Math.round(clamp(score, 1, 99));

  return {
    setupType,
    setupLabel: labelSetup(setupType),
    setupQualityScore,
    setupStrength:
      setupQualityScore >= 84 ? "sniper" :
      setupQualityScore >= 76 ? "strong" :
      setupQualityScore >= 66 ? "medium" :
      "weak",
    volatilityRegime,
    trendRegime,
    triggerType,
    entryModel,
    distanceEma20Atr: Number(distanceEma20Atr.toFixed(2)),
    wickRiskScore: Math.round(wickRiskScore),
    lateImpulse
  };
}

function computeWickRiskScore(direction, upperWickRatio, lowerWickRatio, bodyRatio) {
  let score = 30;

  if (direction === "buy") {
    score += upperWickRatio * 90;
    if (lowerWickRatio > 0.32) score -= 10;
  }

  if (direction === "sell") {
    score += lowerWickRatio * 90;
    if (upperWickRatio > 0.32) score -= 10;
  }

  if (bodyRatio < 0.25) score += 10;

  return clamp(score, 1, 99);
}

function isLateImpulse(pair, distanceEma20Atr, impulseTooLarge) {
  const maxDistance =
    pair === "BTCUSD" ? 3.1 :
    pair === "XAUUSD" ? 2.75 :
    2.45;

  return distanceEma20Atr > maxDistance || impulseTooLarge;
}

function getVolatilityRegime(pair, volatility, atrPercent) {
  const p = String(pair || "").toUpperCase();

  if (p === "BTCUSD") {
    if (volatility > 0.04 || atrPercent > 0.045) return "extreme";
    if (volatility > 0.025 || atrPercent > 0.028) return "elevated";
    if (volatility < 0.003 || atrPercent < 0.002) return "quiet";
    return "normal";
  }

  if (p === "XAUUSD") {
    if (volatility > 0.025 || atrPercent > 0.03) return "extreme";
    if (volatility > 0.016 || atrPercent > 0.018) return "elevated";
    if (volatility < 0.001 || atrPercent < 0.0008) return "quiet";
    return "normal";
  }

  if (volatility > 0.018 || atrPercent > 0.018) return "extreme";
  if (volatility > 0.011 || atrPercent > 0.011) return "elevated";
  if (volatility < 0.00035 || atrPercent < 0.00025) return "quiet";

  return "normal";
}

function labelSetup(type) {
  const labels = {
    "trend-pullback": "Trend pullback",
    "breakout-continuation": "Breakout continuation",
    "liquidity-rejection": "Liquidity rejection",
    "momentum-continuation": "Momentum continuation",
    "range-signal": "Range signal",
    "late-impulse": "Late impulse",
    "weak-signal": "Weak signal"
  };

  return labels[type] || "Unknown setup";
}

function computePaperCandidateScore(data) {
  return (
    Number(data.ultraScore || 0) * 0.24 +
    Number(data.entryQualityScore || 0) * 0.20 +
    Number(data.setupQualityScore || 50) * 0.18 +
    Number(data.archiveScore || 50) * 0.12 +
    Number(data.executionScore || 50) * 0.08 +
    Number(data.smartMoneyScore || 50) * 0.06 +
    Number(data.riskScore || 50) * 0.06 +
    Number(data.sessionScore || 50) * 0.03 +
    (100 - Number(data.exitPressureScore || 50)) * 0.03
  );
}

function buildBlockReason(data) {
  if (data.signal === "WAIT") return "No directional signal.";
  if (data.ultraScore < MIN_ULTRA_SCORE) return `Ultra score too weak: ${Math.round(data.ultraScore)}/100.`;
  if (data.entryQualityScore < MIN_ENTRY_QUALITY) return `Entry quality too weak: ${Math.round(data.entryQualityScore)}/100.`;
  if (data.setupQualityScore < 66) return `Setup quality too weak: ${Math.round(data.setupQualityScore)}/100.`;
  if (data.exitPressureScore >= 68) return `Exit pressure too high: ${Math.round(data.exitPressureScore)}/100.`;
  if (data.lateEntry) return "Entry is too late after impulse.";
  if (data.archiveBad) return "Archive expectancy is negative.";
  if (data.riskScore < 42) return `Risk score too weak: ${Math.round(data.riskScore)}/100.`;
  if (data.setupType === "weak-signal") return "Setup classifier detected weak signal.";
  if (data.setupType === "late-impulse") return "Setup classifier detected late impulse.";
  if (data.volatilityRegime === "extreme") return "Volatility regime is extreme.";

  return "Not enough confluence.";
}

function computeRiskPercent(scan) {
  const pair = String(scan.pair || "").toUpperCase();
  let riskPercent = 0.25;

  if (scan.ultraScore >= 82 && scan.riskScore >= 52 && scan.entryQualityScore >= 74) riskPercent *= 1.2;
  if (scan.ultraScore >= 88 && scan.riskScore >= 58 && scan.archiveEdgeScore >= 58 && scan.entryQualityScore >= 82) riskPercent *= 1.45;
  if (scan.setupQualityScore >= 82) riskPercent *= 1.1;
  if (scan.historicalEdgeScore >= 70 && scan.historicalConfidence >= 45) riskPercent *= 1.08;

  if (scan.ultraScore < 72) riskPercent *= 0.65;
  if (scan.entryQualityScore < 68) riskPercent *= 0.55;
  if (scan.setupQualityScore < 66) riskPercent *= 0.55;
  if (scan.riskScore < 45) riskPercent *= 0.5;
  if (scan.archiveEdgeScore < 45) riskPercent *= 0.7;
  if (scan.exitPressureScore >= 64) riskPercent *= 0.65;

  if (pair === "XAUUSD") riskPercent *= 0.82;
  if (pair === "BTCUSD") riskPercent *= 0.6;
  if (pair.startsWith("GBP")) riskPercent *= 0.9;

  return Number(Math.max(0.03, Math.min(0.75, riskPercent)).toFixed(2));
}

function getMaxBarsHold(scan, exploration) {
  const timeframe = String(scan.timeframe || DEFAULT_TIMEFRAME).toUpperCase();
  const pair = String(scan.pair || "").toUpperCase();

  let base =
    timeframe === "M5" ? 16 :
    timeframe === "M15" ? 12 :
    timeframe === "H1" ? 9 :
    timeframe === "H4" ? 7 :
    12;

  if (pair === "BTCUSD") base += 2;
  if (scan.setupType === "trend-pullback") base += 2;
  if (scan.setupType === "breakout-continuation") base -= 1;
  if (exploration) base = Math.max(5, base - 4);

  return base;
}

function computeRiskDistance(pair, current, atr14) {
  const atrMultiplier =
    pair === "BTCUSD" ? 1.85 :
    pair === "XAUUSD" ? 1.55 :
    pair.includes("JPY") ? 1.55 :
    1.4;

  const fallback =
    pair === "BTCUSD" ? current * 0.006 :
    pair === "XAUUSD" ? current * 0.003 :
    current * 0.002;

  return atr14 > 0 ? atr14 * atrMultiplier : fallback;
}

function getOriginalRiskDistance(trade) {
  const entry = Number(trade.entry || 0);
  const stop = Number(trade.stopLoss || 0);
  const target = Number(trade.takeProfit || 0);
  const rr = Number(trade.rr || getDefaultRr(trade.pair));

  if (entry && target && rr > 0) return Math.abs(target - entry) / rr;
  if (entry && stop) return Math.abs(entry - stop);

  return 0;
}

function computeLivePnlR(trade, price) {
  const entry = Number(trade.entry || 0);
  const direction = String(trade.direction || "buy").toLowerCase();
  const risk = getOriginalRiskDistance(trade);

  if (!entry || !risk) return 0;

  return direction === "buy"
    ? round((Number(price) - entry) / risk, 3)
    : round((entry - Number(price)) / risk, 3);
}

function computePnlR(trade, exitPrice) {
  return computeLivePnlR(trade, exitPrice);
}

function improveStop(direction, currentStop, candidateStop) {
  if (!currentStop) return candidateStop;

  return direction === "buy"
    ? Math.max(currentStop, candidateStop)
    : Math.min(currentStop, candidateStop);
}

function buildRiskGroupsFromTrades(trades) {
  const groups = {};

  for (const trade of trades || []) {
    const pair = String(trade.pair || "").toUpperCase();

    for (const group of getPairRiskGroups(pair)) {
      groups[group] = (groups[group] || 0) + 1;
    }
  }

  return groups;
}

function wouldOverloadRiskGroup(pair, currentGroups) {
  for (const group of getPairRiskGroups(pair)) {
    const current = Number(currentGroups[group] || 0);

    if (group === "GOLD_USD" && current >= 1) return true;
    if (group === "BTC_USD" && current >= 1) return true;
    if (group === "USD" && current >= 2) return true;
    if (group === "EUR" && current >= 2) return true;
    if (group === "GBP" && current >= 2) return true;
    if (group === "JPY" && current >= 2) return true;
    if (group === "AUD_NZD" && current >= 2) return true;
  }

  return false;
}

function getPairRiskGroups(pair) {
  const p = String(pair || "").toUpperCase();
  const groups = [];

  if (p.includes("USD")) groups.push("USD");
  if (p.includes("EUR")) groups.push("EUR");
  if (p.includes("GBP")) groups.push("GBP");
  if (p.includes("JPY")) groups.push("JPY");
  if (p.includes("AUD") || p.includes("NZD")) groups.push("AUD_NZD");
  if (p === "XAUUSD") groups.push("GOLD_USD");
  if (p === "BTCUSD") groups.push("BTC_USD");

  return [...new Set(groups)];
}

function buildPaperAccountConfig(env = {}, overrides = {}) {
  const startingBalance = Number(
    overrides.startingBalance ||
    env.FTMO_STARTING_BALANCE ||
    env.ACCOUNT_SIZE ||
    10000
  );

  return {
    phase: String(env.FTMO_PHASE || "challenge").toLowerCase(),
    startingBalance: Number.isFinite(startingBalance) && startingBalance > 0 ? startingBalance : 10000,
    maxTradeRiskPercent: Number(env.FTMO_MAX_TRADE_RISK_PERCENT || 0.75),
    maxOpenRiskPercent: Number(env.FTMO_MAX_OPEN_RISK_PERCENT || 2),
    dailyLossLimitPercent: Number(env.FTMO_DAILY_LOSS_LIMIT_PERCENT || 5),
    maxLossLimitPercent: Number(env.FTMO_MAX_LOSS_LIMIT_PERCENT || 10)
  };
}

function getFreshness(candles, timeframe) {
  const lastTs = Number(candles.at(-1)?.time || 0);
  const now = Math.floor(Date.now() / 1000);
  const maxAge = FRESHNESS_SECONDS[timeframe] || FRESHNESS_SECONDS.M15;

  if (!lastTs) {
    return {
      fresh: false,
      ageSeconds: 999999999,
      ageMinutes: 999999
    };
  }

  const ageSeconds = Math.max(0, now - lastTs);

  return {
    fresh: ageSeconds <= maxAge,
    ageSeconds,
    ageMinutes: Math.round(ageSeconds / 60)
  };
}

function scoreWinRate(winRate) {
  return clamp(50 + (Number(winRate || 50) - 50) * 1.35, 1, 99);
}

function scoreExpectancy(value) {
  return clamp(50 + Number(value || 0) * 38, 1, 99);
}

function computeSessionScore(pair = "") {
  const hour = inferHour(new Date());
  const p = String(pair || "").toUpperCase();

  if (p === "BTCUSD") {
    if (hour >= 13 && hour < 23) return 66;
    if (hour >= 1 && hour < 8) return 58;
    return 54;
  }

  if (hour >= 14 && hour < 18) return 68;
  if (hour >= 9 && hour < 14) return 62;
  if (hour >= 18 && hour < 21) return 56;
  if (hour >= 1 && hour < 8) return 52;

  return 44;
}

function weakness(score, level) {
  const n = Number(score || 50);

  if (n >= level + 18) return 0;
  if (n >= level + 10) return 10;
  if (n >= level) return 25;
  if (n >= level - 10) return 45;

  return 65;
}

function ema(values, period) {
  const nums = values.map(Number).filter(Number.isFinite);

  if (!nums.length) return 0;

  const k = 2 / (period + 1);
  let prev = nums[0];

  for (let i = 1; i < nums.length; i += 1) {
    prev = nums[i] * k + prev * (1 - k);
  }

  return prev;
}

function rsi(values, period = 14) {
  const nums = values.map(Number).filter(Number.isFinite);

  if (nums.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = nums.length - period; i < nums.length; i += 1) {
    const diff = nums[i] - nums[i - 1];

    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0 && gains === 0) return 50;
  if (losses === 0) return 100;

  return 100 - 100 / (1 + gains / losses);
}

function atr(highs, lows, closes, period = 14) {
  if (highs.length < 2) return 0;

  const trs = [];

  for (let i = 1; i < highs.length; i += 1) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }

  const recent = trs.slice(-period);

  if (!recent.length) return 0;

  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function computeMomentum(values, lookback = 12) {
  if (values.length <= lookback) return 0;

  const current = values.at(-1);
  const past = values.at(-1 - lookback);

  if (!past) return 0;

  return ((current - past) / past) * 100;
}

function computeVolatility(values, period = 30) {
  const closes = values.slice(-period).map(Number).filter(Number.isFinite);

  if (closes.length < 3) return 0;

  const returns = [];

  for (let i = 1; i < closes.length; i += 1) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  const avg = average(returns);
  const variance = average(returns.map((value) => Math.pow(value - avg, 2)));

  return Math.sqrt(variance);
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);

  if (!nums.length) return 0;

  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function inferSession(date = new Date()) {
  const hour = inferHour(date);

  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const tokyo = hour >= 1 && hour < 10;

  if (london && newYork) return "London+NewYork";
  if (london) return "London";
  if (newYork) return "NewYork";
  if (tokyo) return "Tokyo";

  return "OffSession";
}

function inferHour(date = new Date()) {
  return Number(
    new Date(date).toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );
}

function getDefaultRr(pair) {
  const p = String(pair || "").toUpperCase();

  if (p === "BTCUSD") return 1.45;
  if (p === "XAUUSD") return 1.5;

  return 1.35;
}

function normalizeTimeframe(value) {
  const tf = String(value || "").toUpperCase().trim();

  return ["M5", "M15", "H1", "H4"].includes(tf) ? tf : "";
}

function extractSetupTypeFromTag(tag) {
  const text = String(tag || "");

  const known = [
    "trend-pullback",
    "breakout-continuation",
    "liquidity-rejection",
    "momentum-continuation",
    "range-signal",
    "late-impulse",
    "weak-signal"
  ];

  return known.find((item) => text.includes(item)) || "unknown";
}

function roundByPair(value, pair) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  const p = String(pair || "").toUpperCase();

  if (p === "XAUUSD" || p === "BTCUSD") return Number(n.toFixed(2));
  if (p.includes("JPY")) return Number(n.toFixed(3));

  return Number(n.toFixed(5));
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Number(n.toFixed(digits));
}

function clamp(value, min = 1, max = 99) {
  const n = Number(value);

  if (!Number.isFinite(n)) return min;

  return Math.max(min, Math.min(max, n));
}

function isAuthorized(request, secret) {
  if (!secret) return true;

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  return token === secret || bearer === secret;
}

async function safeJson(request) {
  try {
    const contentType = request.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("application/json")) {
      return {};
    }

    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}
