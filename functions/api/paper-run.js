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

import {
  applyModelRulesToScans
} from "../_shared/model-rules.js";

const MODEL_VERSION = "server-paper-v11-sniper-long-trade-complete";
const DEFAULT_TIMEFRAME = "M15";
const CANDLE_LIMIT = 420;

const ALL_PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

const DEFAULT_SNIPER_PAIRS = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "EURJPY",
  "GBPJPY",
  "XAUUSD"
];

const BLOCKED_BY_DEFAULT = new Set([
  "BTCUSD",
  "AUDNZD",
  "AUDCAD",
  "NZDCAD",
  "NZDJPY",
  "AUDCHF",
  "NZDUSD"
]);

const FRESHNESS_SECONDS = {
  M5: 90 * 60,
  M15: 4 * 60 * 60,
  H1: 14 * 60 * 60,
  H4: 42 * 60 * 60
};

const DEFAULT_CONFIG = {
  maxOpenTrades: 2,
  maxNewTradesPerRun: 1,

  minCandles: 90,

  minUltraScore: 84,
  minPaperScore: 88,
  minEntryQuality: 80,
  minSetupQuality: 78,
  maxExitPressure: 45,
  minRiskScore: 58,
  minExecutionScore: 62,
  minSmartMoneyScore: 58,

  allowExploration: false,
  allowMediumNews: false,
  blockHighNews: true,

  minArchiveTradesForBlock: 12,

  maxTradeRiskPercent: 0.28,
  baseRiskPercent: 0.16,

  breakEvenAtR: 0.45,
  breakEvenLockR: 0.04,

  firstProtectionAtR: 0.75,
  firstProtectionLockR: 0.16,

  trailStartAtR: 1.05,
  trailLockR: 0.42,

  strongTrailAtR: 1.55,
  strongTrailLockR: 0.82,

  closeOnExitPressureAfterBarsM5: 32,
  closeOnExitPressureAfterBarsM15: 16,
  closeOnExitPressureAfterBarsH1: 5,
  closeOnExitPressureAfterBarsH4: 3,

  emergencyExitPressure: 92,
  maxNegativeSignalDecayR: -0.45
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
      return json({ ok: false, source: "paper-run", version: MODEL_VERSION, error: "Missing DB binding" }, 500);
    }

    if (!isAuthorized(context.request, secret)) {
      return json({ ok: false, source: "paper-run", version: MODEL_VERSION, error: "Unauthorized" }, 401);
    }

    await ensurePaperTables(db);
    await ensureArchiveColumns(db);
    await ensurePaperColumns(db);

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    const timeframe = normalizeTimeframe(url.searchParams.get("timeframe") || body.timeframe) || DEFAULT_TIMEFRAME;
    const dryRun = readBool(url, body, "dryRun", false);
    const config = buildConfig(env, url, body);
    const pairs = resolvePairs(env, url, body);

    const account = buildPaperAccountConfig(env, {
      startingBalance:
        url.searchParams.get("startingBalance") ||
        body.startingBalance ||
        env.FTMO_STARTING_BALANCE
    });

    const rawScans = await scanAllPairs(db, timeframe, pairs, config);

    const historicalScans = await Promise.all(
      rawScans.map(async (scan) => {
        if (!scan || scan.signal === "WAIT") return scan;

        const historical = await buildHistoricalEdgeGate(db, {
          ...scan,
          session: inferSession(new Date()),
          hour: inferHour(new Date())
        }, {
          mode: "sniper-long-trade"
        });

        const historicalEdgeScore = Number(historical.edgeScore || 50);
        const historicalConfidence = Number(historical.confidence || 0);

        const adjustedPaperScore = Math.round(
          Number(scan.paperScore || 0) * 0.82 +
          historicalEdgeScore * 0.18
        );

        const enoughHistory = historicalConfidence >= 35;
        const historyBad =
          enoughHistory &&
          historical.learningAllowed === false &&
          historicalEdgeScore < 43;

        return {
          ...scan,
          historicalEdge: historical,
          historicalEdgeScore,
          historicalConfidence,
          paperScore: adjustedPaperScore,
          tradeAllowed: Boolean(scan.tradeAllowed && !historyBad),
          tradeReason: historyBad
            ? `Historical edge blocked: ${historical.reason}`
            : `${scan.tradeReason || "Accepted"} Historical: ${historical.reason}`
        };
      })
    );

    const newsFilteredScans = await applyNewsFilterToScans(db, historicalScans, {
      env,
      timeframe,
      mode: "paper-sniper-long"
    });

    const ftmoScans = await applyFtmoGuardianToScans(db, newsFilteredScans, {
      env,
      timeframe,
      mode: "paper-sniper-long"
    });

    const modelRuleScans = await applyModelRulesToScans(db, ftmoScans, {
      env,
      timeframe,
      mode: "paper-sniper-long"
    });

    const marketScans = modelRuleScans.map((scan) => applyFinalGate(scan, config));

    const openBefore = await getOpenTrades(db, timeframe);

    const closed = dryRun
      ? []
      : await closeOrManageTrades(db, timeframe, openBefore, marketScans, account, env, config);

    const openAfterClose = dryRun
      ? openBefore
      : await getOpenTrades(db, timeframe);

    const opened = dryRun
      ? []
      : await openNewTrades(db, timeframe, openAfterClose, marketScans, account, env, config);

    const durationMs = Date.now() - startedAt;

    if (!dryRun) {
      await insertPaperRun(db, {
        timeframe,
        scannedPairs: marketScans.length,
        opened: opened.length,
        closed: closed.length,
        notes: `${MODEL_VERSION}; duration=${durationMs}ms; account=${account.startingBalance}; pairs=${pairs.join(",")}`
      });
    }

    return json({
      ok: true,
      source: "paper-run",
      version: MODEL_VERSION,
      dryRun,
      timeframe,
      mode: "SNIPER_LONG_TRADE_SERVER_ONLY",
      browserRequired: false,
      account: {
        phase: account.phase,
        startingBalance: account.startingBalance,
        maxTradeRiskPercent: account.maxTradeRiskPercent,
        maxOpenRiskPercent: account.maxOpenRiskPercent,
        dailyLossLimitPercent: account.dailyLossLimitPercent,
        maxLossLimitPercent: account.maxLossLimitPercent
      },
      config: publicConfig(config),
      pairs,
      scannedPairs: marketScans.length,
      opened: opened.length,
      closed: closed.length,
      openBefore: openBefore.length,
      openAfter: openAfterClose.length + opened.length,
      durationMs,
      topCandidates: marketScans
        .slice()
        .sort((a, b) => Number(b.paperScore || 0) - Number(a.paperScore || 0))
        .slice(0, 16)
        .map(publicScan),
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
    ["sniper_score", "REAL"],
    ["tp1", "REAL"],
    ["management_state", "TEXT"]
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

async function scanAllPairs(db, timeframe, pairs, config) {
  const scans = [];

  for (const pair of pairs) {
    const candles = await getCandles(db, pair, timeframe);
    const freshness = getFreshness(candles, timeframe);

    if (candles.length < config.minCandles) {
      scans.push(buildEmptyScan(pair, timeframe, candles, `Not enough candles: ${candles.length}/${config.minCandles}`));
      continue;
    }

    if (!freshness.fresh) {
      scans.push(buildEmptyScan(pair, timeframe, candles, `Stale candles: ${freshness.ageMinutes} min old`));
      continue;
    }

    const archive = await getArchiveStats(db, pair, timeframe);
    const scan = buildScan(pair, timeframe, candles, archive, freshness, config);

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
    rowCount: candles.length,
    fresh: false,
    candleAgeMinutes: null,
    current: Number(candles.at(-1)?.close || 0),
    direction: "wait",
    signal: "WAIT",
    ultraScore: 0,
    trendScore: 0,
    timingScore: 0,
    riskScore: 0,
    sessionScore: 0,
    executionScore: 0,
    smartMoneyScore: 0,
    archiveEdgeScore: 50,
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
    lateImpulse: false,
    entryQualityScore: 0,
    entryQualityLabel: "no-data",
    entryQualityReasons: [reason],
    exitPressureScore: 99,
    exitPressureLabel: "no-data",
    rsi14: 50,
    atr14: 0,
    momentum: 0,
    volatility: 0,
    rr: getWinrateTargetRr(pair, timeframe),
    stopLoss: 0,
    takeProfit: 0,
    tp1: 0,
    session: inferSession(new Date()),
    hour: inferHour(new Date()),
    tradeAllowed: false,
    tradeStatus: "NO DATA",
    tradeReason: reason,
    archive: null,
    paperScore: 0
  };
}

function buildScan(pair, timeframe, candles, archive, freshness, config) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const current = closes.at(-1);
  const previous = closes.at(-2) || current;

  const ema20Value = ema(closes, 20);
  const ema50Value = ema(closes, 50);
  const ema100Value = ema(closes, 100);
  const ema200Value = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(highs, lows, closes, 14);
  const momentum = computeMomentum(closes, 12);
  const volatility = computeVolatility(closes, 40);
  const macdLine = ema(closes, 12) - ema(closes, 26);
  const session = inferSession(new Date());
  const hour = inferHour(new Date());

  const direction = getDirection({
    pair,
    current,
    ema20Value,
    ema50Value,
    ema100Value,
    ema200Value,
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
    ema200Value,
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

  const riskScore = computeRiskScore(pair, volatility, atr14, current, timeframe);
  const sessionScore = computeSessionScore(pair, timeframe, hour);
  const executionScore = computeExecutionScore(candles, direction, atr14);
  const smartMoneyScore = computeSmartMoneyScore(candles, direction);
  const archiveScore = computeArchiveScore(archive, direction);

  const setup = classifySetup({
    pair,
    timeframe,
    candles,
    current,
    direction,
    atr14,
    volatility,
    ema20Value,
    ema50Value
  });

  const rr = getWinrateTargetRr(pair, timeframe, setup.setupType);
  const riskDistance = computeRiskDistance(pair, timeframe, current, atr14, setup.setupType);

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
      ? current - riskDistance * 0.78
      : current + riskDistance * 0.78;

  const ultraScore = clamp(
    trendScore * 0.24 +
      timingScore * 0.12 +
      riskScore * 0.12 +
      executionScore * 0.13 +
      smartMoneyScore * 0.10 +
      sessionScore * 0.05 +
      archiveScore * 0.09 +
      setup.setupQualityScore * 0.15,
    1,
    99
  );

  const entry = computeEntryQualityScore({
    pair,
    timeframe,
    candles,
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
    rsi14,
    momentum,
    atr14,
    volatility
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
    archiveEdgeScore: archiveScore,
    setupType: setup.setupType,
    volatilityRegime: setup.volatilityRegime,
    wickRiskScore: setup.wickRiskScore,
    lateImpulse: setup.lateImpulse,
    rsi14,
    momentum,
    volatility
  });

  const dirArchive = getDirectionArchive(archive, direction);
  const archiveBad =
    archive.trades >= config.minArchiveTradesForBlock &&
    (
      archive.expectancy < -0.12 ||
      dirArchive.expectancy < -0.10 ||
      archive.winRate < 43 ||
      dirArchive.winRate < 43
    );

  const allowedSetup =
    setup.setupType === "trend-pullback" ||
    setup.setupType === "liquidity-rejection" ||
    (setup.setupType === "breakout-continuation" && setup.setupQualityScore >= 84);

  const sessionAllowed = isTradableSession(pair, timeframe, hour);

  const tradeAllowed =
    signal !== "WAIT" &&
    allowedSetup &&
    ultraScore >= config.minUltraScore &&
    entry.score >= config.minEntryQuality &&
    setup.setupQualityScore >= config.minSetupQuality &&
    exitPressure.score <= config.maxExitPressure &&
    riskScore >= config.minRiskScore &&
    executionScore >= config.minExecutionScore &&
    smartMoneyScore >= config.minSmartMoneyScore &&
    !setup.lateImpulse &&
    !archiveBad &&
    setup.volatilityRegime !== "extreme" &&
    setup.distanceEma20Atr <= getMaxDistanceEma20(pair, timeframe) &&
    sessionAllowed;

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
    session,
    hour,
    tradeAllowed,
    tradeStatus: tradeAllowed ? "SNIPER_LONG_VALID" : "BLOCKED",
    tradeReason: tradeAllowed
      ? `${setup.setupLabel} accepted by sniper long-trade gate.`
      : buildBlockReason({
          signal,
          allowedSetup,
          ultraScore,
          entryQualityScore: entry.score,
          setupQualityScore: setup.setupQualityScore,
          exitPressureScore: exitPressure.score,
          riskScore,
          executionScore,
          smartMoneyScore,
          lateEntry: setup.lateImpulse,
          archiveBad,
          setupType: setup.setupType,
          volatilityRegime: setup.volatilityRegime,
          distanceEma20Atr: setup.distanceEma20Atr,
          sessionAllowed
        }),
    archive,
    paperScore: Math.round(paperScore)
  };
}

function applyFinalGate(scan, config) {
  if (!scan || scan.signal === "WAIT") return scan;

  const newsRisk = String(scan.newsRiskLevel || "").toUpperCase();

  if (config.blockHighNews && newsRisk === "HIGH") {
    return blockScan(scan, "High-impact news risk.");
  }

  if (!config.allowMediumNews && newsRisk === "MEDIUM") {
    return blockScan(scan, "Medium news risk blocked in sniper mode.");
  }

  if (scan.ftmoAllowed === false) {
    return blockScan(scan, `FTMO blocked: ${scan.ftmoReason || "risk guard"}`);
  }

  if (Number(scan.modelRulesScoreDelta || 0) <= -10) {
    return blockScan(scan, "Model rules penalty too strong.");
  }

  if (Number(scan.paperScore || 0) < config.minPaperScore) {
    return blockScan(scan, `Paper score too weak for sniper mode: ${Math.round(Number(scan.paperScore || 0))}/100.`);
  }

  return scan;
}

function blockScan(scan, reason) {
  return {
    ...scan,
    tradeAllowed: false,
    tradeStatus: "BLOCKED",
    tradeReason: reason
  };
}

function buildBlockReason(data) {
  if (data.signal === "WAIT") return "No clean sniper direction.";
  if (!data.allowedSetup) return `Setup not allowed in sniper mode: ${data.setupType}.`;
  if (data.ultraScore < DEFAULT_CONFIG.minUltraScore) return `Ultra score too weak: ${Math.round(data.ultraScore)}/100.`;
  if (data.entryQualityScore < DEFAULT_CONFIG.minEntryQuality) return `Entry quality too weak: ${Math.round(data.entryQualityScore)}/100.`;
  if (data.setupQualityScore < DEFAULT_CONFIG.minSetupQuality) return `Setup quality too weak: ${Math.round(data.setupQualityScore)}/100.`;
  if (data.exitPressureScore > DEFAULT_CONFIG.maxExitPressure) return `Exit pressure too high: ${Math.round(data.exitPressureScore)}/100.`;
  if (data.riskScore < DEFAULT_CONFIG.minRiskScore) return `Risk score too weak: ${Math.round(data.riskScore)}/100.`;
  if (data.executionScore < DEFAULT_CONFIG.minExecutionScore) return `Execution score too weak: ${Math.round(data.executionScore)}/100.`;
  if (data.smartMoneyScore < DEFAULT_CONFIG.minSmartMoneyScore) return `Smart-money score too weak: ${Math.round(data.smartMoneyScore)}/100.`;
  if (data.lateEntry) return "Entry is too late after impulse.";
  if (data.archiveBad) return "Archive expectancy/winrate is negative.";
  if (data.volatilityRegime === "extreme") return "Volatility regime is extreme.";
  if (data.distanceEma20Atr > 1.7) return `Entry too far from EMA20: ${data.distanceEma20Atr} ATR.`;
  if (!data.sessionAllowed) return "Session blocked for sniper mode.";
  return "Not enough sniper confluence.";
}

function getDirection(data) {
  const rsi = Number(data.rsi14 || 50);
  const momentum = Number(data.momentum || 0);

  const bullish =
    data.ema20Value > data.ema50Value &&
    data.ema50Value > data.ema100Value * 0.998 &&
    data.current > data.ema20Value &&
    momentum > 0.015 &&
    rsi >= 48 &&
    rsi <= 68;

  const bearish =
    data.ema20Value < data.ema50Value &&
    data.ema50Value < data.ema100Value * 1.002 &&
    data.current < data.ema20Value &&
    momentum < -0.015 &&
    rsi <= 52 &&
    rsi >= 32;

  if (bullish) return "buy";
  if (bearish) return "sell";
  return "wait";
}

function computeTrendScore(data) {
  let score = 50;

  const direction = data.direction;

  if (direction === "buy") {
    score += data.ema20Value > data.ema50Value ? 16 : -18;
    score += data.ema50Value > data.ema100Value ? 10 : -12;
    score += data.ema100Value > data.ema200Value ? 5 : -4;
    score += data.current > data.ema20Value ? 8 : -10;
    score += data.momentum > 0 ? 10 : -10;
  } else if (direction === "sell") {
    score += data.ema20Value < data.ema50Value ? 16 : -18;
    score += data.ema50Value < data.ema100Value ? 10 : -12;
    score += data.ema100Value < data.ema200Value ? 5 : -4;
    score += data.current < data.ema20Value ? 8 : -10;
    score += data.momentum < 0 ? 10 : -10;
  } else {
    score -= 20;
  }

  return clamp(score, 1, 99);
}

function computeTimingScore(data) {
  let score = 50;

  if (data.direction === "buy") {
    score += data.rsi14 >= 48 && data.rsi14 <= 64 ? 16 : -12;
    score += data.macdLine > 0 ? 8 : -8;
    score += data.momentum > 0 ? 8 : -8;
    score += data.current >= data.previous ? 4 : -5;
    if (data.rsi14 > 70) score -= 18;
  } else if (data.direction === "sell") {
    score += data.rsi14 <= 52 && data.rsi14 >= 36 ? 16 : -12;
    score += data.macdLine < 0 ? 8 : -8;
    score += data.momentum < 0 ? 8 : -8;
    score += data.current <= data.previous ? 4 : -5;
    if (data.rsi14 < 30) score -= 18;
  } else {
    score -= 14;
  }

  return clamp(score, 1, 99);
}

function computeRiskScore(pair, volatility, atr14, current, timeframe) {
  let score = 78;

  const atrPercent = current ? atr14 / current : 0;

  if (pair === "XAUUSD") score -= 6;
  if (pair.startsWith("GBP")) score -= 2;

  if (timeframe === "H1") score += 4;
  if (timeframe === "H4") score += 6;

  if (pair === "XAUUSD") {
    if (atrPercent >= 0.001 && atrPercent <= 0.012) score += 8;
    if (atrPercent > 0.02) score -= 14;
    if (Number(volatility || 0) > 0.018) score -= 10;
  } else if (pair.includes("JPY")) {
    if (atrPercent >= 0.00035 && atrPercent <= 0.007) score += 7;
    if (atrPercent > 0.012) score -= 12;
    if (Number(volatility || 0) > 0.012) score -= 9;
  } else {
    if (atrPercent >= 0.00025 && atrPercent <= 0.0065) score += 8;
    if (atrPercent > 0.011) score -= 12;
    if (Number(volatility || 0) > 0.010) score -= 8;
  }

  return clamp(score, 1, 99);
}

function computeExecutionScore(candles, direction, atr14) {
  if (candles.length < 30 || direction === "wait") return 45;

  const last = candles.at(-1);
  const prev = candles.at(-2);
  const range = Math.max(0.0000001, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;

  let score = 50;

  if (bodyRatio >= 0.38 && bodyRatio <= 0.78) score += 12;
  if (atr14 > 0 && range <= atr14 * 1.65) score += 8;
  if (atr14 > 0 && range > atr14 * 2.15) score -= 16;

  if (direction === "buy") {
    if (last.close > last.open) score += 8;
    if (last.close > prev.close) score += 6;
    if (last.close > last.low + range * 0.62) score += 6;
  }

  if (direction === "sell") {
    if (last.close < last.open) score += 8;
    if (last.close < prev.close) score += 6;
    if (last.close < last.high - range * 0.62) score += 6;
  }

  return clamp(score, 1, 99);
}

function computeSmartMoneyScore(candles, direction) {
  if (candles.length < 36 || direction === "wait") return 45;

  const recent = candles.slice(-14);
  const previous = candles.slice(-32, -14);
  const last = candles.at(-1);

  const recentRange = average(recent.map((c) => c.high - c.low));
  const previousRange = average(previous.map((c) => c.high - c.low));
  const body = Math.abs(last.close - last.open);
  const range = Math.max(0.0000001, last.high - last.low);
  const bodyRatio = body / range;

  let score = 50;

  if (recentRange >= previousRange * 0.85 && recentRange <= previousRange * 1.55) score += 8;
  if (bodyRatio >= 0.45 && bodyRatio <= 0.78) score += 10;

  if (direction === "buy" && last.close > last.open) score += 8;
  if (direction === "sell" && last.close < last.open) score += 8;

  return clamp(score, 1, 99);
}

function computeArchiveScore(archive, direction) {
  const dirStats = getDirectionArchive(archive, direction);

  const confidence =
    archive.trades >= 40 ? 1 :
    archive.trades >= 20 ? 0.78 :
    archive.trades >= 10 ? 0.55 :
    0.25;

  const pairScore =
    scoreWinRate(archive.winRate) * 0.52 +
    scoreExpectancy(archive.expectancy) * 0.48;

  const dirScore =
    scoreWinRate(dirStats.winRate) * 0.55 +
    scoreExpectancy(dirStats.expectancy) * 0.45;

  const raw = pairScore * 0.42 + dirScore * 0.58;

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

  score += (Number(data.ultraScore || 0) - 70) * 0.20;
  score += (Number(data.setupQualityScore || 50) - 50) * 0.24;
  score += (Number(data.trendScore || 50) - 50) * 0.14;
  score += (Number(data.executionScore || 50) - 50) * 0.14;
  score += (Number(data.smartMoneyScore || 50) - 50) * 0.10;
  score += (Number(data.timingScore || 50) - 50) * 0.08;
  score += (Number(data.archiveScore || 50) - 50) * 0.05;
  score += (Number(data.riskScore || 50) - 50) * 0.05;

  if (data.setupType === "trend-pullback") {
    score += 10;
    reasons.push("Trend pullback priority");
  }

  if (data.setupType === "liquidity-rejection") score += 6;
  if (data.setupType === "breakout-continuation") score += 2;
  if (data.setupType === "momentum-continuation") score -= 5;
  if (data.setupType === "range-signal") score -= 20;
  if (data.setupType === "late-impulse") score -= 28;

  if (data.wickRiskScore >= 60) score -= 10;
  if (data.distanceEma20Atr > 1.65) score -= 10;
  if (data.distanceEma20Atr > 2.1) score -= 18;

  if (data.direction === "buy" && data.rsi14 > 68) score -= 12;
  if (data.direction === "sell" && data.rsi14 < 32) score -= 12;

  if (data.pair === "XAUUSD") score -= 2;

  const finalScore = clamp(score, 1, 99);

  return {
    score: Math.round(finalScore),
    label:
      finalScore >= 88 ? "elite-sniper-entry" :
      finalScore >= 80 ? "sniper-entry" :
      finalScore >= 72 ? "clean-entry" :
      "weak-entry",
    reasons
  };
}

function computeExitPressureScore(scan, trade = null, livePnlR = 0) {
  let score = 22;

  score += weakness(scan.trendScore, 54) * 0.18;
  score += weakness(scan.executionScore, 54) * 0.17;
  score += weakness(scan.timingScore, 50) * 0.13;
  score += weakness(scan.smartMoneyScore, 52) * 0.12;
  score += weakness(scan.riskScore, 52) * 0.10;
  score += weakness(scan.archiveEdgeScore || scan.archiveScore, 46) * 0.08;

  if (String(scan.signal || "").toUpperCase() === "WAIT") score += 10;
  if (scan.lateImpulse) score += 16;
  if (scan.setupType === "late-impulse") score += 15;
  if (scan.setupType === "range-signal") score += 12;
  if (scan.volatilityRegime === "elevated") score += 8;
  if (scan.volatilityRegime === "extreme") score += 20;
  if (Number(scan.wickRiskScore || 0) >= 65) score += 9;

  if (trade) {
    const direction = String(trade.direction || "").toLowerCase();
    const tradeSignal = direction === "sell" ? "SELL" : "BUY";
    const scanSignal = String(scan.signal || "").toUpperCase();

    if (
      (tradeSignal === "BUY" && scanSignal === "SELL") ||
      (tradeSignal === "SELL" && scanSignal === "BUY")
    ) {
      score += livePnlR < 0.5 ? 20 : 8;
    }
  }

  if (livePnlR >= 0.75) score -= 7;
  if (livePnlR >= 1.15) score -= 9;
  if (livePnlR <= -0.55) score += 8;

  const finalScore = clamp(score, 1, 99);

  return {
    score: Math.round(finalScore),
    label:
      finalScore >= 90 ? "emergency-close-pressure" :
      finalScore >= 74 ? "high-pressure" :
      finalScore >= 55 ? "monitor-pressure" :
      "hold"
  };
}

function classifySetup(input) {
  const pair = String(input.pair || "").toUpperCase();
  const timeframe = normalizeTimeframe(input.timeframe) || DEFAULT_TIMEFRAME;
  const candles = Array.isArray(input.candles) ? input.candles : [];
  const direction = String(input.direction || "wait").toLowerCase();

  if (candles.length < 40 || (direction !== "buy" && direction !== "sell")) {
    return emptySetup();
  }

  const closes = candles.map((c) => Number(c.close || 0)).filter(Number.isFinite);
  const highs = candles.map((c) => Number(c.high || 0)).filter(Number.isFinite);
  const lows = candles.map((c) => Number(c.low || 0)).filter(Number.isFinite);

  const current = Number(input.current || closes.at(-1) || 0);
  const last = candles.at(-1);

  const ema20Value = Number(input.ema20Value || ema(closes, 20));
  const ema50Value = Number(input.ema50Value || ema(closes, 50));
  const atrValue = Number(input.atr14 || atr(highs, lows, closes, 14));
  const volatility = Number(input.volatility || computeVolatility(closes, 40));

  const range = Math.max(0.0000001, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;

  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  const upperWickRatio = upperWick / range;
  const lowerWickRatio = lowerWick / range;

  const distanceEma20Atr = atrValue > 0 ? Math.abs(current - ema20Value) / atrValue : 0;
  const atrPercent = current > 0 ? atrValue / current : 0;

  const recent = candles.slice(-16);
  const prevHigh = Math.max(...recent.slice(0, -1).map((c) => c.high));
  const prevLow = Math.min(...recent.slice(0, -1).map((c) => c.low));

  const trendUp = ema20Value > ema50Value && current > ema20Value;
  const trendDown = ema20Value < ema50Value && current < ema20Value;

  const trendRegime =
    trendUp ? "uptrend" :
    trendDown ? "downtrend" :
    Math.abs(ema20Value - ema50Value) / Math.max(current, 0.0000001) < 0.0012 ? "range" :
    "mixed";

  const volatilityRegime = getVolatilityRegime(pair, volatility, atrPercent);

  const buyBreakout = direction === "buy" && last.close > prevHigh && last.close > last.open && bodyRatio >= 0.50;
  const sellBreakout = direction === "sell" && last.close < prevLow && last.close < last.open && bodyRatio >= 0.50;

  const buyPullback =
    direction === "buy" &&
    trendUp &&
    last.low <= ema20Value + atrValue * 0.55 &&
    last.close > ema20Value &&
    last.close > last.open &&
    distanceEma20Atr <= 1.45;

  const sellPullback =
    direction === "sell" &&
    trendDown &&
    last.high >= ema20Value - atrValue * 0.55 &&
    last.close < ema20Value &&
    last.close < last.open &&
    distanceEma20Atr <= 1.45;

  const buyRejection =
    direction === "buy" &&
    trendRegime !== "range" &&
    lowerWickRatio >= 0.36 &&
    upperWickRatio <= 0.30 &&
    last.close > last.open &&
    last.close > last.low + range * 0.62;

  const sellRejection =
    direction === "sell" &&
    trendRegime !== "range" &&
    upperWickRatio >= 0.36 &&
    lowerWickRatio <= 0.30 &&
    last.close < last.open &&
    last.close < last.high - range * 0.62;

  const impulseTooLarge = atrValue > 0 && range > atrValue * getImpulseMaxMultiplier(pair, timeframe);
  const lateImpulse = isLateImpulse(pair, timeframe, distanceEma20Atr, impulseTooLarge);
  const wickRiskScore = computeWickRiskScore(direction, upperWickRatio, lowerWickRatio, bodyRatio);

  let setupType = "weak-signal";
  let triggerType = "none";
  let entryModel = "none";
  let score = 45;

  if (buyPullback || sellPullback) {
    setupType = "trend-pullback";
    triggerType = "ema20-reclaim";
    entryModel = "long-hold-pullback-confirmation";
    score += 32;
  } else if (buyRejection || sellRejection) {
    setupType = "liquidity-rejection";
    triggerType = "wick-rejection";
    entryModel = "liquidity-rejection-confirmation";
    score += 26;
  } else if (buyBreakout || sellBreakout) {
    setupType = "breakout-continuation";
    triggerType = "range-break";
    entryModel = "breakout-confirmation-strict";
    score += 20;
  } else if (
    (direction === "buy" && trendUp && bodyRatio >= 0.45) ||
    (direction === "sell" && trendDown && bodyRatio >= 0.45)
  ) {
    setupType = "momentum-continuation";
    triggerType = "momentum-candle";
    entryModel = "momentum-confirmation-risk";
    score += 8;
  } else if (trendRegime === "range") {
    setupType = "range-signal";
    triggerType = "range";
    entryModel = "blocked-range";
    score -= 14;
  }

  if (trendRegime === "uptrend" && direction === "buy") score += 9;
  if (trendRegime === "downtrend" && direction === "sell") score += 9;
  if (trendRegime === "mixed") score -= 8;
  if (trendRegime === "range") score -= 16;

  if (bodyRatio >= 0.40 && bodyRatio <= 0.78) score += 8;
  if (wickRiskScore >= 60) score -= 12;

  if (lateImpulse) {
    setupType = "late-impulse";
    triggerType = "late";
    entryModel = "avoid-late-entry";
    score -= 30;
  } else if (distanceEma20Atr <= 1.15) {
    score += 9;
  } else if (distanceEma20Atr <= 1.65) {
    score += 3;
  } else {
    score -= 12;
  }

  if (volatilityRegime === "normal") score += 7;
  if (volatilityRegime === "quiet") score -= 7;
  if (volatilityRegime === "elevated") score -= pair === "XAUUSD" ? 10 : 8;
  if (volatilityRegime === "extreme") score -= 24;

  if (pair === "XAUUSD") score -= 2;
  if (timeframe === "H1") score += 4;
  if (timeframe === "H4") score += 5;

  const setupQualityScore = Math.round(clamp(score, 1, 99));

  return {
    setupType,
    setupLabel: labelSetup(setupType),
    setupQualityScore,
    setupStrength:
      setupQualityScore >= 88 ? "elite" :
      setupQualityScore >= 80 ? "sniper" :
      setupQualityScore >= 72 ? "strong" :
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

function emptySetup() {
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

function computeWickRiskScore(direction, upperWickRatio, lowerWickRatio, bodyRatio) {
  let score = 24;

  if (direction === "buy") {
    score += upperWickRatio * 105;
    if (lowerWickRatio > 0.34) score -= 8;
  }

  if (direction === "sell") {
    score += lowerWickRatio * 105;
    if (upperWickRatio > 0.34) score -= 8;
  }

  if (bodyRatio < 0.25) score += 12;

  return clamp(score, 1, 99);
}

function isLateImpulse(pair, timeframe, distanceEma20Atr, impulseTooLarge) {
  const maxDistance = getMaxDistanceEma20(pair, timeframe);

  return distanceEma20Atr > maxDistance || impulseTooLarge;
}

function getMaxDistanceEma20(pair, timeframe) {
  const p = String(pair || "").toUpperCase();
  const tf = normalizeTimeframe(timeframe) || DEFAULT_TIMEFRAME;

  if (tf === "H4") return p === "XAUUSD" ? 2.05 : 1.9;
  if (tf === "H1") return p === "XAUUSD" ? 1.85 : 1.7;
  if (tf === "M15") return p === "XAUUSD" ? 1.65 : 1.55;

  return 1.45;
}

function getImpulseMaxMultiplier(pair, timeframe) {
  const p = String(pair || "").toUpperCase();
  const tf = normalizeTimeframe(timeframe) || DEFAULT_TIMEFRAME;

  if (p === "XAUUSD") return tf === "M15" ? 2.05 : 2.35;
  if (tf === "H1" || tf === "H4") return 2.45;

  return 2.15;
}

function getVolatilityRegime(pair, volatility, atrPercent) {
  const p = String(pair || "").toUpperCase();

  if (p === "XAUUSD") {
    if (volatility > 0.024 || atrPercent > 0.028) return "extreme";
    if (volatility > 0.016 || atrPercent > 0.018) return "elevated";
    if (volatility < 0.0008 || atrPercent < 0.0007) return "quiet";
    return "normal";
  }

  if (p.includes("JPY")) {
    if (volatility > 0.015 || atrPercent > 0.015) return "extreme";
    if (volatility > 0.010 || atrPercent > 0.010) return "elevated";
    if (volatility < 0.00035 || atrPercent < 0.0003) return "quiet";
    return "normal";
  }

  if (volatility > 0.013 || atrPercent > 0.013) return "extreme";
  if (volatility > 0.0085 || atrPercent > 0.0085) return "elevated";
  if (volatility < 0.00028 || atrPercent < 0.00024) return "quiet";

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
    Number(data.ultraScore || 0) * 0.26 +
    Number(data.entryQualityScore || 0) * 0.22 +
    Number(data.setupQualityScore || 50) * 0.20 +
    Number(data.executionScore || 50) * 0.10 +
    Number(data.smartMoneyScore || 50) * 0.08 +
    Number(data.archiveScore || 50) * 0.06 +
    Number(data.riskScore || 50) * 0.05 +
    Number(data.sessionScore || 50) * 0.02 +
    (100 - Number(data.exitPressureScore || 50)) * 0.01
  );
}

function buildBlockReason(data) {
  if (data.signal === "WAIT") return "No clean sniper direction.";
  if (!data.allowedSetup) return `Setup not allowed in sniper mode: ${data.setupType}.`;
  if (data.ultraScore < DEFAULT_CONFIG.minUltraScore) return `Ultra score too weak: ${Math.round(data.ultraScore)}/100.`;
  if (data.entryQualityScore < DEFAULT_CONFIG.minEntryQuality) return `Entry quality too weak: ${Math.round(data.entryQualityScore)}/100.`;
  if (data.setupQualityScore < DEFAULT_CONFIG.minSetupQuality) return `Setup quality too weak: ${Math.round(data.setupQualityScore)}/100.`;
  if (data.exitPressureScore > DEFAULT_CONFIG.maxExitPressure) return `Exit pressure too high: ${Math.round(data.exitPressureScore)}/100.`;
  if (data.riskScore < DEFAULT_CONFIG.minRiskScore) return `Risk score too weak: ${Math.round(data.riskScore)}/100.`;
  if (data.executionScore < DEFAULT_CONFIG.minExecutionScore) return `Execution score too weak: ${Math.round(data.executionScore)}/100.`;
  if (data.smartMoneyScore < DEFAULT_CONFIG.minSmartMoneyScore) return `Smart-money score too weak: ${Math.round(data.smartMoneyScore)}/100.`;
  if (data.lateEntry) return "Entry is too late after impulse.";
  if (data.archiveBad) return "Archive expectancy/winrate is negative.";
  if (data.volatilityRegime === "extreme") return "Volatility regime is extreme.";
  if (data.distanceEma20Atr > 1.7) return `Entry too far from EMA20: ${data.distanceEma20Atr} ATR.`;
  if (!data.sessionAllowed) return "Session blocked for sniper mode.";
  return "Not enough sniper confluence.";
}

function computeRiskPercent(scan, config) {
  const pair = String(scan.pair || "").toUpperCase();
  let riskPercent = Number(config.baseRiskPercent || 0.16);

  if (scan.ultraScore >= 90 && scan.entryQualityScore >= 86 && scan.setupQualityScore >= 86) riskPercent *= 1.25;
  if (scan.ultraScore >= 94 && scan.archiveEdgeScore >= 60 && scan.historicalEdgeScore >= 62) riskPercent *= 1.15;

  if (scan.ultraScore < 88) riskPercent *= 0.75;
  if (scan.entryQualityScore < 82) riskPercent *= 0.75;
  if (scan.setupQualityScore < 80) riskPercent *= 0.75;
  if (scan.riskScore < 65) riskPercent *= 0.7;
  if (scan.archiveEdgeScore < 48) riskPercent *= 0.75;
  if (scan.exitPressureScore >= 40) riskPercent *= 0.72;

  if (pair === "XAUUSD") riskPercent *= 0.72;
  if (pair.startsWith("GBP")) riskPercent *= 0.86;
  if (pair.includes("JPY")) riskPercent *= 0.9;

  return Number(Math.max(0.04, Math.min(config.maxTradeRiskPercent, riskPercent)).toFixed(2));
}

function getMaxBarsHold(scan) {
  const timeframe = String(scan.timeframe || DEFAULT_TIMEFRAME).toUpperCase();
  const pair = String(scan.pair || "").toUpperCase();
  const setupType = String(scan.setupType || "");

  let base =
    timeframe === "M5" ? 72 :
    timeframe === "M15" ? 96 :
    timeframe === "H1" ? 72 :
    timeframe === "H4" ? 36 :
    96;

  if (pair === "XAUUSD") base = Math.round(base * 0.78);
  if (setupType === "trend-pullback") base = Math.round(base * 1.12);
  if (setupType === "breakout-continuation") base = Math.round(base * 0.82);

  return Math.max(12, base);
}

function computeRiskDistance(pair, timeframe, current, atr14, setupType) {
  const tf = normalizeTimeframe(timeframe) || DEFAULT_TIMEFRAME;
  const p = String(pair || "").toUpperCase();

  let atrMultiplier =
    tf === "H4" ? 2.55 :
    tf === "H1" ? 2.35 :
    tf === "M15" ? 2.15 :
    1.95;

  if (p === "XAUUSD") atrMultiplier += 0.25;
  if (p.includes("JPY")) atrMultiplier += 0.1;
  if (setupType === "liquidity-rejection") atrMultiplier += 0.15;
  if (setupType === "breakout-continuation") atrMultiplier -= 0.15;

  const fallback =
    p === "XAUUSD" ? current * 0.0045 :
    p.includes("JPY") ? current * 0.003 :
    current * 0.0026;

  return atr14 > 0 ? atr14 * atrMultiplier : fallback;
}

function getOriginalRiskDistance(trade) {
  const entry = Number(trade.entry || 0);
  const stop = Number(trade.stopLoss || 0);
  const target = Number(trade.takeProfit || 0);
  const rr = Number(trade.rr || getWinrateTargetRr(trade.pair, trade.timeframe));

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
    if (group === "USD" && current >= 1) return true;
    if (group === "EUR" && current >= 1) return true;
    if (group === "GBP" && current >= 1) return true;
    if (group === "JPY" && current >= 1) return true;
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
  if (p === "XAUUSD") groups.push("GOLD_USD");

  return [...new Set(groups)];
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

function getWinrateTargetRr(pair, timeframe, setupType = "") {
  const p = String(pair || "").toUpperCase();
  const tf = normalizeTimeframe(timeframe) || DEFAULT_TIMEFRAME;

  let rr =
    tf === "H4" ? 1.22 :
    tf === "H1" ? 1.12 :
    tf === "M15" ? 1.02 :
    0.95;

  if (p === "XAUUSD") rr -= 0.07;
  if (setupType === "trend-pullback") rr += 0.04;
  if (setupType === "liquidity-rejection") rr -= 0.02;
  if (setupType === "breakout-continuation") rr += 0.02;

  return Number(Math.max(0.85, Math.min(1.28, rr)).toFixed(2));
}

function scoreWinRate(winRate) {
  return clamp(50 + (Number(winRate || 50) - 50) * 1.5, 1, 99);
}

function scoreExpectancy(value) {
  return clamp(50 + Number(value || 0) * 36, 1, 99);
}

function computeSessionScore(pair = "", timeframe = DEFAULT_TIMEFRAME, hour = inferHour(new Date())) {
  const p = String(pair || "").toUpperCase();
  const tf = normalizeTimeframe(timeframe) || DEFAULT_TIMEFRAME;

  if (tf === "H1" || tf === "H4") {
    if (hour >= 8 && hour < 22) return 68;
    if (hour >= 1 && hour < 8) return p.includes("JPY") ? 62 : 50;
    return 46;
  }

  if (p === "XAUUSD") {
    if (hour >= 14 && hour < 19) return 72;
    if (hour >= 9 && hour < 14) return 58;
    return 44;
  }

  if (hour >= 14 && hour < 18) return 70;
  if (hour >= 9 && hour < 14) return 64;
  if (hour >= 18 && hour < 21) return 55;
  if (hour >= 1 && hour < 8 && p.includes("JPY")) return 58;

  return 44;
}

function isTradableSession(pair, timeframe, hour) {
  const p = String(pair || "").toUpperCase();
  const tf = normalizeTimeframe(timeframe) || DEFAULT_TIMEFRAME;

  if (tf === "H1" || tf === "H4") {
    return hour >= 6 && hour < 23;
  }

  if (p === "XAUUSD") {
    return hour >= 9 && hour < 21;
  }

  if (p.includes("JPY")) {
    return (hour >= 7 && hour < 21) || (hour >= 1 && hour < 6);
  }

  return hour >= 8 && hour < 21;
}

function weakness(score, level) {
  const n = Number(score || 50);

  if (n >= level + 20) return 0;
  if (n >= level + 10) return 8;
  if (n >= level) return 22;
  if (n >= level - 10) return 42;

  return 68;
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

function computeVolatility(values, period = 40) {
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

function buildConfig(env, url, body) {
  return {
    ...DEFAULT_CONFIG,
    maxOpenTrades: readNumber(url, body, env, "maxOpenTrades", "PAPER_MAX_OPEN_TRADES", DEFAULT_CONFIG.maxOpenTrades),
    maxNewTradesPerRun: readNumber(url, body, env, "maxNewTradesPerRun", "PAPER_MAX_NEW_TRADES_PER_RUN", DEFAULT_CONFIG.maxNewTradesPerRun),
    minUltraScore: readNumber(url, body, env, "minUltraScore", "PAPER_MIN_ULTRA_SCORE", DEFAULT_CONFIG.minUltraScore),
    minPaperScore: readNumber(url, body, env, "minPaperScore", "PAPER_MIN_PAPER_SCORE", DEFAULT_CONFIG.minPaperScore),
    minEntryQuality: readNumber(url, body, env, "minEntryQuality", "PAPER_MIN_ENTRY_QUALITY", DEFAULT_CONFIG.minEntryQuality),
    minSetupQuality: readNumber(url, body, env, "minSetupQuality", "PAPER_MIN_SETUP_QUALITY", DEFAULT_CONFIG.minSetupQuality),
    maxExitPressure: readNumber(url, body, env, "maxExitPressure", "PAPER_MAX_EXIT_PRESSURE", DEFAULT_CONFIG.maxExitPressure),
    allowMediumNews: readBool(url, body, "allowMediumNews", false),
    baseRiskPercent: readNumber(url, body, env, "baseRiskPercent", "PAPER_BASE_RISK_PERCENT", DEFAULT_CONFIG.baseRiskPercent),
    maxTradeRiskPercent: readNumber(url, body, env, "maxTradeRiskPercent", "PAPER_MAX_TRADE_RISK_PERCENT", DEFAULT_CONFIG.maxTradeRiskPercent)
  };
}

function resolvePairs(env, url, body) {
  const raw =
    url.searchParams.get("pairs") ||
    body.pairs ||
    env.PAPER_ALLOWED_PAIRS ||
    DEFAULT_SNIPER_PAIRS.join(",");

  const requested = String(raw || "")
    .split(",")
    .map(normalizePair)
    .filter(Boolean);

  const unique = [...new Set(requested.length ? requested : DEFAULT_SNIPER_PAIRS)];

  return unique.filter((pair) => {
    if (BLOCKED_BY_DEFAULT.has(pair) && env.PAPER_ALLOW_BLOCKED_PAIRS !== "1") {
      return false;
    }

    return ALL_PAIRS.includes(pair);
  });
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

function publicConfig(config) {
  return {
    maxOpenTrades: config.maxOpenTrades,
    maxNewTradesPerRun: config.maxNewTradesPerRun,
    minUltraScore: config.minUltraScore,
    minPaperScore: config.minPaperScore,
    minEntryQuality: config.minEntryQuality,
    minSetupQuality: config.minSetupQuality,
    maxExitPressure: config.maxExitPressure,
    allowExploration: config.allowExploration,
    allowMediumNews: config.allowMediumNews,
    baseRiskPercent: config.baseRiskPercent,
    maxTradeRiskPercent: config.maxTradeRiskPercent,
    breakEvenAtR: config.breakEvenAtR,
    firstProtectionAtR: config.firstProtectionAtR,
    trailStartAtR: config.trailStartAtR
  };
}

function publicScan(scan) {
  return {
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
    modelRulesApplied: scan.modelRulesApplied || 0,
    modelRulesScoreDelta: scan.modelRulesScoreDelta || 0,
    tradeAllowed: scan.tradeAllowed,
    tradeStatus: scan.tradeStatus,
    tradeReason: scan.tradeReason,
    ftmoAllowed: scan.ftmoAllowed,
    ftmoStatus: scan.ftmoStatus,
    ftmoRecommendedRiskPercent: scan.ftmoRecommendedRiskPercent,
    ftmoRecommendedRiskAmount: scan.ftmoRecommendedRiskAmount,
    ftmoReason: scan.ftmoReason
  };
}

function normalizePair(value) {
  return String(value || "")
    .toUpperCase()
    .replaceAll(".", "")
    .replaceAll("_", "")
    .replaceAll("-", "")
    .trim();
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

function readNumber(url, body, env, queryKey, envKey, fallback) {
  const queryValue = url.searchParams.get(queryKey);
  const bodyValue = body?.[queryKey];
  const envValue = env?.[envKey];
  const value = queryValue ?? bodyValue ?? envValue ?? fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readBool(url, body, key, fallback = false) {
  const queryValue = url.searchParams.get(key);

  if (queryValue !== null && queryValue !== undefined && queryValue !== "") {
    return queryValue === "1" || queryValue.toLowerCase() === "true";
  }

  const bodyValue = body?.[key];

  if (bodyValue !== null && bodyValue !== undefined && bodyValue !== "") {
    if (typeof bodyValue === "boolean") return bodyValue;
    return String(bodyValue) === "1" || String(bodyValue).toLowerCase() === "true";
  }

  return fallback;
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
