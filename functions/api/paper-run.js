import {
  buildHistoricalEdgeGate,
  ensureArchiveColumns
} from "../_shared/archive-intelligence.js";

const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

const MODEL_VERSION = "server-paper-v7-archive-intelligence";
const DEFAULT_TIMEFRAME = "M15";
const CANDLE_LIMIT = 260;
const MAX_OPEN_TRADES = 4;
const MIN_ULTRA_SCORE = 72;
const MIN_ENTRY_QUALITY = 68;
const EXPLORATION_MIN_ULTRA_SCORE = 60;
const EXPLORATION_MIN_ENTRY_QUALITY = 58;
const ACCOUNT_SIZE = 10000;

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

    await ensureArchiveColumns(db);

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    const timeframe =
      normalizeTimeframe(url.searchParams.get("timeframe") || body.timeframe) ||
      DEFAULT_TIMEFRAME;

    const dryRun = String(url.searchParams.get("dryRun") || body.dryRun || "0") === "1";

    const rawMarketScans = await scanAllPairs(db, timeframe);

    const marketScans = await Promise.all(
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

    const openBefore = await getOpenTrades(db, timeframe);

    const closed = dryRun
      ? []
      : await closeOrManageTrades(db, timeframe, openBefore, marketScans);

    const openAfterClose = dryRun
      ? openBefore
      : await getOpenTrades(db, timeframe);

    const opened = dryRun
      ? []
      : await openNewTrades(db, timeframe, openAfterClose, marketScans);

    const durationMs = Date.now() - startedAt;

    if (!dryRun) {
      await insertPaperRun(db, {
        timeframe,
        scannedPairs: marketScans.length,
        opened: opened.length,
        closed: closed.length,
        notes: `${MODEL_VERSION}; duration=${durationMs}ms`
      });
    }

    return json({
      ok: true,
      source: "paper-run",
      version: MODEL_VERSION,
      dryRun,
      timeframe,
      scannedPairs: marketScans.length,
      opened: opened.length,
      closed: closed.length,
      openBefore: openBefore.length,
      openAfter: openAfterClose.length + opened.length,
      durationMs,
      topCandidates: marketScans
        .slice()
        .sort((a, b) => Number(b.paperScore || 0) - Number(a.paperScore || 0))
        .slice(0, 8)
        .map((scan) => ({
          pair: scan.pair,
          signal: scan.signal,
          ultraScore: scan.ultraScore,
          entryQualityScore: scan.entryQualityScore,
          setupQualityScore: scan.setupQualityScore,
          exitPressureScore: scan.exitPressureScore,
          paperScore: scan.paperScore,
          historicalEdgeScore: scan.historicalEdgeScore,
          historicalConfidence: scan.historicalConfidence,
          setupType: scan.setupType,
          tradeAllowed: scan.tradeAllowed,
          tradeStatus: scan.tradeStatus,
          tradeReason: scan.tradeReason
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
    timeframe,
    candles,
    current,
    direction,
    signal,
    atr14,
    volatility,
    momentum,
    rsi14
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
    archiveScore,
    setupType: setup.setupType,
    volatilityRegime: setup.volatilityRegime,
    wickRiskScore: setup.wickRiskScore,
    lateImpulse: setup.lateImpulse,
    rsi14,
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
    tradeStatus: tradeAllowed
      ? pair === "BTCUSD"
        ? "VALID BTC V7"
        : pair === "XAUUSD"
          ? "VALID GOLD V7"
          : "VALID V7"
      : "BLOCKED V7",
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
