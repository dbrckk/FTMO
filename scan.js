import { API } from "./config.js";
import { appState } from "./state.js";
import { fetchMlScore, fetchVectorbtScore } from "./api.js";
import { clamp, round } from "./utils.js";

const CANDLE_LIMIT = 220;

export async function scanPair(pairInput) {
  const pair = typeof pairInput === "string"
    ? pairInput.toUpperCase()
    : String(pairInput?.symbol || "").toUpperCase();

  const timeframe = appState.timeframe || "M15";

  try {
    const candles = await fetchMarketCandles(pair, timeframe);

    if (candles.length < 40) {
      return buildEmptyScan(pair, timeframe, candles, "Not enough candles");
    }

    const baseScan = buildScan(pair, timeframe, candles);

    const [mlResult, vectorbtResult] = await Promise.allSettled([
      fetchMlScore(baseScan),
      fetchVectorbtScore(baseScan)
    ]);

    const ml =
      mlResult.status === "fulfilled" && mlResult.value
        ? mlResult.value
        : null;

    const vectorbt =
      vectorbtResult.status === "fulfilled" && vectorbtResult.value
        ? vectorbtResult.value
        : null;

    baseScan.mlScore = Number(ml?.mlScore ?? baseScan.localScore ?? 50);
    baseScan.mlConfidenceBand = ml?.confidenceBand || "medium";
    baseScan.vectorbtScore = Number(vectorbt?.vectorbtScore ?? 55);
    baseScan.vectorbtConfidenceBand = vectorbt?.confidenceBand || "medium";
    baseScan.vectorbtMetrics = vectorbt?.metrics || null;

    finalizeScores(baseScan);

    return baseScan;
  } catch (error) {
    return buildEmptyScan(pair, timeframe, [], String(error?.message || error || "scan-error"));
  }
}

async function fetchMarketCandles(pair, timeframe) {
  const url = new URL(API.market, window.location.origin);
  url.searchParams.set("pair", pair);
  url.searchParams.set("timeframe", timeframe);
  url.searchParams.set("limit", String(CANDLE_LIMIT));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`market-data ${response.status}`);
  }

  const data = await response.json();

  const raw =
    Array.isArray(data?.candles) ? data.candles :
    Array.isArray(data?.data?.candles) ? data.data.candles :
    Array.isArray(data?.rows) ? data.rows :
    Array.isArray(data) ? data :
    [];

  return raw
    .map(normalizeCandle)
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function normalizeCandle(row) {
  const time = Number(row.time ?? row.ts ?? row.timestamp ?? 0);
  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);

  if (
    !Number.isFinite(time) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    close <= 0
  ) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close
  };
}

function buildEmptyScan(pair, timeframe, candles, reason) {
  return {
    pair,
    timeframe,
    candles,
    current: candles.at(-1)?.close || 0,
    direction: "wait",
    signal: "WAIT",
    finalScore: 0,
    ultraScore: 0,
    ultraGrade: "NO DATA",
    localScore: 0,
    mlScore: 0,
    vectorbtScore: 0,
    trendScore: 0,
    timingScore: 0,
    riskScore: 0,
    contextScore: 0,
    smartMoneyScore: 0,
    sessionScore: 0,
    executionScore: 0,
    archiveEdgeScore: 50,
    archiveStats: null,
    archiveConfidence: 0,
    rsi14: 50,
    macdLine: 0,
    atr14: 0,
    momentum: 0,
    rr: 0,
    stopLoss: 0,
    takeProfit: 0,
    tradeAllowed: false,
    tradeStatus: "NO DATA",
    tradeReason: reason,
    reason,
    reasons: [reason]
  };
}

function buildScan(pair, timeframe, candles) {
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
  const macdLine = ema(closes, 12) - ema(closes, 26);
  const volatility = computeVolatility(closes, 30);

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

  const riskScore = clamp(
    74 -
      (pair === "XAUUSD" ? 8 : 0) -
      (pair === "BTCUSD" ? 10 : 0) -
      (pair.startsWith("GBP") ? 2 : 0) -
      Math.min(18, volatility * 850),
    1,
    99
  );

  const contextScore = computeContextScore(pair, timeframe);
  const sessionScore = scoreSession(pair);
  const smartMoneyScore = computeSmartMoneyScore(candles, direction);
  const executionScore = computeExecutionScore(candles, direction, atr14);
  const entryTriggerScore = computeEntryTriggerScore(candles, direction);

  const archiveStats = appState.archiveStatsCache?.[pair] || null;
  const archive = computeArchiveEdge(archiveStats, direction);

  const rr =
    pair === "XAUUSD" ? 2.2 :
    pair === "BTCUSD" ? 2.1 :
    2.0;

  const atrMultiplier =
    pair === "XAUUSD" ? 1.55 :
    pair === "BTCUSD" ? 1.85 :
    1.4;

  const fallbackRiskDistance =
    pair === "BTCUSD" ? current * 0.006 :
    current * 0.002;

  const riskDistance = atr14 > 0
    ? atr14 * atrMultiplier
    : fallbackRiskDistance;

  const stopLoss =
    direction === "sell"
      ? current + riskDistance
      : current - riskDistance;

  const takeProfit =
    direction === "sell"
      ? current - riskDistance * rr
      : current + riskDistance * rr;

  const localScore = clamp(
    trendScore * 0.25 +
      timingScore * 0.20 +
      riskScore * 0.14 +
      contextScore * 0.10 +
      smartMoneyScore * 0.10 +
      executionScore * 0.09 +
      archive.archiveEdgeScore * 0.12,
    1,
    99
  );

  const reasons = buildReasons({
    pair,
    direction,
    trendScore,
    timingScore,
    riskScore,
    contextScore,
    smartMoneyScore,
    executionScore,
    archive,
    rsi14,
    momentum,
    rr
  });

  return {
    pair,
    timeframe,
    candles,
    current: roundByPair(current, pair),
    direction,
    signal,
    localScore: Math.round(localScore),
    finalScore: Math.round(localScore),
    ultraScore: Math.round(localScore),
    ultraGrade: gradeScore(localScore),

    trendScore: Math.round(trendScore),
    timingScore: Math.round(timingScore),
    riskScore: Math.round(riskScore),
    contextScore: Math.round(contextScore),
    smartMoneyScore: Math.round(smartMoneyScore),
    sessionScore: Math.round(sessionScore),
    executionScore: Math.round(executionScore),
    entryTriggerScore: Math.round(entryTriggerScore),

    entrySniper: {
      score: Math.round(entryTriggerScore),
      label: entryTriggerScore >= 70 ? "clean trigger" : "normal trigger"
    },

    exitSniper: {
      score: Math.round(computeExitPressureScore(candles, direction)),
      label: "exit pressure"
    },

    archiveEdgeScore: Math.round(archive.archiveEdgeScore),
    archiveConfidence: archive.archiveConfidence,
    archiveStats: archive,

    mlScore: 50,
    mlConfidenceBand: "pending",
    vectorbtScore: 55,
    vectorbtConfidenceBand: "pending",

    rsi14: round(rsi14, 2),
    macdLine: round(macdLine, 6),
    atr14: roundByPair(atr14, pair),
    momentum: round(momentum, 3),
    volatility: round(volatility, 5),

    rr,
    stopLoss: roundByPair(stopLoss, pair),
    takeProfit: roundByPair(takeProfit, pair),

    tradeAllowed: false,
    tradeStatus: "WAIT",
    tradeReason: "Final score pending",
    reason: "Final score pending",
    reasons
  };
}

function finalizeScores(scan) {
  const mlScore = Number(scan.mlScore || 50);
  const vectorbtScore = Number(scan.vectorbtScore || 55);
  const localScore = Number(scan.localScore || 50);

  const finalScore = clamp(
    localScore * 0.46 +
      mlScore * 0.24 +
      vectorbtScore * 0.16 +
      Number(scan.archiveEdgeScore || 50) * 0.14,
    1,
    99
  );

  let ultraScore = clamp(
    finalScore * 0.62 +
      Number(scan.trendScore || 0) * 0.10 +
      Number(scan.timingScore || 0) * 0.10 +
      Number(scan.executionScore || 0) * 0.08 +
      Number(scan.smartMoneyScore || 0) * 0.05 +
      Number(scan.sessionScore || 0) * 0.05,
    1,
    99
  );

  if (scan.pair === "XAUUSD") {
    ultraScore = clamp(ultraScore + 2, 1, 99);
  }

  if (scan.pair === "BTCUSD") {
    ultraScore = clamp(ultraScore + 1, 1, 99);
  }

  const archiveBad =
    Number(scan.archiveConfidence || 0) >= 12 &&
    Number(scan.archiveStats?.pairExpectancy || 0) < -0.35 &&
    Number(scan.archiveStats?.directionExpectancy || 0) < -0.25;

  const allowed =
    scan.signal !== "WAIT" &&
    ultraScore >= 72 &&
    Number(scan.riskScore || 0) >= 45 &&
    !archiveBad;

  scan.finalScore = Math.round(finalScore);
  scan.ultraScore = Math.round(ultraScore);
  scan.ultraGrade = gradeScore(ultraScore);
  scan.tradeAllowed = allowed;

  scan.tradeStatus = allowed
    ? scan.pair === "XAUUSD"
      ? "VALID GOLD"
      : scan.pair === "BTCUSD"
        ? "VALID BTC"
        : "VALID"
    : archiveBad
      ? "BLOCKED ARCHIVE"
      : "BLOCKED";

  scan.tradeReason = allowed
    ? "Setup accepted by scanner confluence."
    : archiveBad
      ? "Archive expectancy negative."
      : "Not enough confluence.";

  scan.reason = scan.tradeReason;
}

function getDirection({ current, ema20Value, ema50Value, momentum, rsi14 }) {
  const bullish =
    ema20Value > ema50Value &&
    current > ema20Value &&
    momentum > 0 &&
    rsi14 >= 45;

  const bearish =
    ema20Value < ema50Value &&
    current < ema20Value &&
    momentum < 0 &&
    rsi14 <= 55;

  if (bullish) return "buy";
  if (bearish) return "sell";

  return "wait";
}

function computeTrendScore({ current, ema20Value, ema50Value, ema100Value, momentum, direction }) {
  let score = 50;

  score += ema20Value > ema50Value ? 14 : -14;
  score += ema50Value > ema100Value ? 8 : -8;
  score += current > ema20Value ? 8 : -8;
  score += momentum > 0 ? 10 : -10;

  if (direction === "buy" && current > ema20Value && ema20Value > ema50Value) score += 8;
  if (direction === "sell" && current < ema20Value && ema20Value < ema50Value) score += 8;
  if (direction === "wait") score -= 8;

  return clamp(score, 1, 99);
}

function computeTimingScore({ rsi14, macdLine, momentum, current, previous, direction }) {
  let score = 50;

  score += rsi14 >= 43 && rsi14 <= 66 ? 14 : -8;
  score += macdLine > 0 ? 8 : -8;
  score += momentum > 0 ? 8 : -8;
  score += current > previous ? 5 : -5;

  if (direction === "sell") {
    score += macdLine < 0 ? 8 : -8;
    score += momentum < 0 ? 8 : -8;
    score += current < previous ? 5 : -5;
  }

  if (direction === "wait") score -= 6;

  return clamp(score, 1, 99);
}

function computeContextScore(pair, timeframe) {
  let score = 58;

  if (timeframe === "H1") score += 5;
  if (timeframe === "H4") score += 8;
  if (timeframe === "M5") score -= 5;

  if (pair === "XAUUSD") score += 3;
  if (pair === "BTCUSD") score += 2;
  if (pair.startsWith("GBP")) score -= 2;

  return clamp(score, 1, 99);
}

function computeSmartMoneyScore(candles, direction) {
  if (candles.length < 20 || direction === "wait") return 50;

  const recent = candles.slice(-12);
  const previous = candles.slice(-24, -12);

  const recentRange = average(recent.map((c) => c.high - c.low));
  const previousRange = average(previous.map((c) => c.high - c.low));
  const last = candles.at(-1);

  let score = 50;

  if (recentRange > previousRange) score += 8;

  const body = Math.abs(last.close - last.open);
  const range = Math.max(0.0000001, last.high - last.low);
  const bodyRatio = body / range;

  if (bodyRatio >= 0.55) score += 10;

  if (direction === "buy" && last.close > last.open) score += 8;
  if (direction === "sell" && last.close < last.open) score += 8;

  return clamp(score, 1, 99);
}

function computeExecutionScore(candles, direction, atr14) {
  if (candles.length < 30 || direction === "wait") return 50;

  const last = candles.at(-1);
  const range = Math.max(0.0000001, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;

  let score = 52;

  if (bodyRatio >= 0.45) score += 10;
  if (atr14 > 0 && range <= atr14 * 1.8) score += 8;
  if (direction === "buy" && last.close > last.open) score += 7;
  if (direction === "sell" && last.close < last.open) score += 7;

  return clamp(score, 1, 99);
}

function computeEntryTriggerScore(candles, direction) {
  if (candles.length < 5 || direction === "wait") return 45;

  const last = candles.at(-1);
  const prev = candles.at(-2);

  let score = 50;

  if (direction === "buy") {
    if (last.close > last.open) score += 12;
    if (last.close > prev.high) score += 14;
    if (last.low >= prev.low) score += 5;
  }

  if (direction === "sell") {
    if (last.close < last.open) score += 12;
    if (last.close < prev.low) score += 14;
    if (last.high <= prev.high) score += 5;
  }

  return clamp(score, 1, 99);
}

function computeExitPressureScore(candles, direction) {
  if (candles.length < 5 || direction === "wait") return 50;

  const last = candles.at(-1);
  const prev = candles.at(-2);

  let score = 50;

  if (direction === "buy") {
    if (last.close < last.open) score += 12;
    if (last.close < prev.low) score += 14;
  }

  if (direction === "sell") {
    if (last.close > last.open) score += 12;
    if (last.close > prev.high) score += 14;
  }

  return clamp(score, 1, 99);
}

function computeArchiveEdge(stats, direction) {
  if (!stats) {
    return {
      archiveEdgeScore: 50,
      archiveConfidence: 0,
      pairWinRate: 50,
      pairExpectancy: 0,
      directionWinRate: 50,
      directionExpectancy: 0,
      sameDirectionWinRate: 50,
      sameDirectionExpectancy: 0
    };
  }

  const dir = String(direction || "buy").toLowerCase();
  const dirStats = stats.directions?.[dir] || {};

  const pairWinRate = Number(stats.pairWinRate ?? 50);
  const pairExpectancy = Number(stats.pairExpectancy ?? 0);
  const directionWinRate = Number(dirStats.winRate ?? 50);
  const directionExpectancy = Number(dirStats.expectancy ?? 0);
  const confidence = Number(stats.archiveConfidence || stats.pairTradesCount || 0);

  const confidenceFactor =
    confidence >= 40 ? 1 :
    confidence >= 25 ? 0.9 :
    confidence >= 12 ? 0.75 :
    confidence >= 6 ? 0.6 :
    0.45;

  const raw =
    scoreWinRate(pairWinRate) * 0.38 +
    scoreWinRate(directionWinRate) * 0.34 +
    scoreExpectancy(pairExpectancy) * 0.14 +
    scoreExpectancy(directionExpectancy) * 0.14;

  const archiveEdgeScore = clamp(50 + (raw - 50) * confidenceFactor, 1, 99);

  return {
    archiveEdgeScore,
    archiveConfidence: confidence,
    pairWinRate,
    pairExpectancy,
    directionWinRate,
    directionExpectancy,
    sameDirectionWinRate: directionWinRate,
    sameDirectionExpectancy: directionExpectancy
  };
}

function buildReasons(data) {
  const reasons = [];

  reasons.push(`Direction: ${data.direction.toUpperCase()}`);
  reasons.push(`Trend score: ${Math.round(data.trendScore)}`);
  reasons.push(`Timing score: ${Math.round(data.timingScore)}`);
  reasons.push(`Risk score: ${Math.round(data.riskScore)}`);
  reasons.push(`Smart money score: ${Math.round(data.smartMoneyScore)}`);
  reasons.push(`Execution score: ${Math.round(data.executionScore)}`);
  reasons.push(`Archive edge: ${Math.round(data.archive.archiveEdgeScore)}`);
  reasons.push(`RSI14: ${round(data.rsi14, 2)}`);
  reasons.push(`Momentum: ${round(data.momentum, 3)}%`);
  reasons.push(`RR: ${data.rr}`);

  return reasons;
}

export function computeHedgeScore(scan) {
  const pair = String(scan?.pair || "").toUpperCase();

  let score = 50;

  if (pair.includes("USD")) score += 8;
  if (pair.includes("JPY")) score += 5;
  if (pair === "XAUUSD") score += 12;
  if (pair === "BTCUSD") score += 10;
  if (scan?.signal === "WAIT") score -= 10;

  return clamp(score, 1, 99);
}

export function isEliteTrade(scan) {
  return (
    Boolean(scan?.tradeAllowed) &&
    Number(scan?.ultraScore || 0) >= 82 &&
    Number(scan?.riskScore || 0) >= 52 &&
    Number(scan?.archiveEdgeScore || 50) >= 55
  );
}

export function computeConfluenceScore(scan) {
  const score = clamp(
    Number(scan?.trendScore || 0) * 0.22 +
      Number(scan?.timingScore || 0) * 0.18 +
      Number(scan?.riskScore || 0) * 0.14 +
      Number(scan?.smartMoneyScore || 0) * 0.14 +
      Number(scan?.executionScore || 0) * 0.12 +
      Number(scan?.archiveEdgeScore || 50) * 0.20,
    1,
    99
  );

  return {
    score: Math.round(score),
    label:
      score >= 82 ? "elite confluence" :
      score >= 72 ? "strong confluence" :
      score >= 60 ? "medium confluence" :
      "weak confluence"
  };
}

function scoreWinRate(winRate) {
  return clamp(50 + (Number(winRate || 50) - 50) * 1.35, 1, 99);
}

function scoreExpectancy(value) {
  return clamp(50 + Number(value || 0) * 36, 1, 99);
}

function scoreSession(pair = "") {
  const hour = Number(
    new Date().toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );

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

  const rs = gains / losses;

  return 100 - 100 / (1 + rs);
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

function roundByPair(value, pair) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  if (pair === "XAUUSD") return Number(n.toFixed(2));
  if (pair === "BTCUSD") return Number(n.toFixed(2));
  if (String(pair).includes("JPY")) return Number(n.toFixed(3));

  return Number(n.toFixed(5));
}

function gradeScore(score) {
  const n = Number(score || 0);

  if (n >= 90) return "S+";
  if (n >= 84) return "S";
  if (n >= 78) return "A+";
  if (n >= 72) return "A";
  if (n >= 64) return "B";
  if (n >= 55) return "C";

  return "D";
}
