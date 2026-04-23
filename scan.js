import { API } from "./config.js";
import { appState } from "./state.js";
import { normalizeCandles, clamp } from "./utils.js";
import { emaSeries, computeMomentum, rsi, atr } from "./indicators.js";
import { generateFakeCandles } from "./mock.js";
import { fetchMlScore, fetchVectorbtScore } from "./api.js";
import { computeUltraScore, getTradeFilterDecision } from "./advanced-engine.js";

export async function scanPair(pair) {
  let candles = [];

  try {
    const response = await fetch(API.market, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        pair: pair.symbol,
        timeframe: appState.timeframe
      })
    });

    if (!response.ok) throw new Error(`market ${response.status}`);

    const data = await response.json();

    candles = Array.isArray(data.candles) && data.candles.length
      ? normalizeCandles(data.candles)
      : generateFakeCandles(pair.symbol);
  } catch {
    candles = generateFakeCandles(pair.symbol);
  }

  const closes = candles.map((c) => Number(c.close || 0));
  const highs = candles.map((c) => Number(c.high || 0));
  const lows = candles.map((c) => Number(c.low || 0));

  const current = closes.at(-1) || 0;
  const ema20 = emaSeries(closes, 20).at(-1) || current;
  const ema50 = emaSeries(closes, 50).at(-1) || current;
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(highs, lows, closes, 14);
  const macdLine =
    (emaSeries(closes, 12).at(-1) || 0) -
    (emaSeries(closes, 26).at(-1) || 0);
  const momentum = computeMomentum(closes, 12);

  const trendScore = clamp(
    50 +
      (ema20 > ema50 ? 18 : -18) +
      (current > ema20 ? 8 : -8) +
      (momentum > 0 ? 6 : -6),
    1,
    99
  );

  const timingScore = clamp(
    50 +
      (rsi14 > 45 && rsi14 < 65 ? 14 : -8) +
      (macdLine > 0 ? 8 : -8),
    1,
    99
  );

  const riskScore = clamp(
    70 -
      (pair.symbol === "XAUUSD" ? 8 : 0) -
      (pair.symbol === "NAS100" ? 10 : 0),
    1,
    99
  );

  const contextScore = clamp(
    50 + (pair.tier === 1 ? 8 : pair.tier === 2 ? 3 : -2),
    1,
    99
  );

  const stopLoss = current - (atr14 || current * 0.002) * 1.4;
  const takeProfit = current + (atr14 || current * 0.002) * 2.6;
  const rr = Math.abs(
    (takeProfit - current) / ((current - stopLoss) || 0.00001)
  );

  const scan = {
    pair: pair.symbol,
    group: pair.group,
    tier: pair.tier,
    timeframe: appState.timeframe,
    candles,
    current,
    ema20,
    ema50,
    rsi14,
    atr14,
    macdLine,
    momentum,
    trendScore,
    timingScore,
    riskScore,
    contextScore,
    rr: Number(rr.toFixed(2)),
    stopLoss,
    takeProfit,
    signal: "WAIT",
    direction: "buy",
    reasons: [],
    entryTriggerScore: 50,
    entrySniper: {
      score: 50,
      quality: "neutral",
      action: "WAIT",
      reason: "Neutral."
    },
    exitSniper: {
      score: 50,
      quality: "neutral",
      action: "HOLD",
      reason: "Neutral."
    }
  };

  try {
    const ml = await fetchMlScore(scan);
    scan.mlScore = Number(ml.mlScore || 50);
    scan.mlConfidenceBand = ml.confidenceBand || "medium";
    scan.mlExplanation = ml.explanation || "";
  } catch {
    scan.mlScore = 50;
    scan.mlConfidenceBand = "medium";
    scan.mlExplanation = "fallback";
  }

  try {
    const vb = await fetchVectorbtScore(scan);
    scan.vectorbtScore = Number(vb.vectorbtScore || 50);
    scan.vectorbtConfidenceBand = vb.confidenceBand || "medium";
    scan.vectorbtExplanation = vb.explanation || "";
  } catch {
    scan.vectorbtScore = 50;
    scan.vectorbtConfidenceBand = "medium";
    scan.vectorbtExplanation = "fallback";
  }

  scan.finalScore = clamp(
    Math.round(
      scan.trendScore * 0.25 +
      scan.timingScore * 0.20 +
      scan.contextScore * 0.15 +
      scan.riskScore * 0.10 +
      scan.mlScore * 0.15 +
      scan.vectorbtScore * 0.15
    ),
    1,
    99
  );

  scan.signal =
    scan.finalScore >= 70
      ? "BUY"
      : scan.finalScore <= 35
        ? "SELL"
        : "WAIT";

  scan.direction = scan.signal === "SELL" ? "sell" : "buy";
  scan.reason =
    scan.mlExplanation || scan.vectorbtExplanation || "Analyse consolidée";

  scan.reasons = [
    `Trend ${scan.trendScore}`,
    `Timing ${scan.timingScore}`,
    `Risk ${scan.riskScore}`,
    `Context ${scan.contextScore}`,
    `ML ${scan.mlScore}`,
    `VectorBT ${scan.vectorbtScore}`
  ];

  const ultra = computeUltraScore(scan);
  const filterDecision = getTradeFilterDecision(scan);

  scan.ultraScore = ultra.ultraScore;
  scan.ultraGrade = ultra.grade;
  scan.smartMoneyScore = ultra.smartMoney;
  scan.sessionScore = ultra.session;
  scan.executionScore = ultra.execution;

  scan.tradeAllowed = filterDecision.allowed;
  scan.tradeStatus = filterDecision.status;
  scan.tradeReason = filterDecision.reason;

  if (!scan.tradeAllowed) {
    scan.signal = "WAIT";
  }

  return scan;
}

export function computeHedgeScore(scan) {
  return Math.round(
    Number(scan.trendScore || 0) * 0.25 +
      Number(scan.timingScore || 0) * 0.2 +
      Number(scan.contextScore || 0) * 0.15 +
      Number(scan.riskScore || 0) * 0.1 +
      Number(scan.mlScore || 0) * 0.15 +
      Number(scan.vectorbtScore || 0) * 0.15
  );
}

export function isEliteTrade(scan) {
  return (
    Number(scan.finalScore || 0) >= 85 &&
    Number(scan.mlScore || 0) >= 75 &&
    Number(scan.vectorbtScore || 0) >= 75
  );
}

export function computeConfluenceScore(scan) {
  const score = Math.round(
    Number(scan.finalScore || 0) * 0.35 +
      Number(scan.mlScore || 0) * 0.2 +
      Number(scan.vectorbtScore || 0) * 0.2 +
      Number(scan.trendScore || 0) * 0.1 +
      Number(scan.timingScore || 0) * 0.1 +
      Number(scan.contextScore || 0) * 0.05
  );

  return {
    score,
    label:
      score >= 85
        ? "institutional"
        : score >= 75
          ? "elite"
          : score >= 65
            ? "strong"
            : score >= 55
              ? "tradable"
              : "weak",
    blocked: score < 55
  };
}
