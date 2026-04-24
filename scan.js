import { API } from "./config.js";
import { appState } from "./state.js";
import { normalizeCandles, clamp } from "./utils.js";
import { emaSeries, computeMomentum, rsi, atr } from "./indicators.js";
import { generateFakeCandles } from "./mock.js";
import { fetchMlScore, fetchVectorbtScore } from "./api.js";
import { computeUltraScore, getTradeFilterDecision } from "./advanced-engine.js";

async function fetchMarketCandles(pairSymbol, timeframe) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = new URL(API.market, window.location.origin);
    url.searchParams.set("pair", pairSymbol);
    url.searchParams.set("timeframe", timeframe);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`market ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function getCurrentParisHour() {
  return Number(
    new Date().toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );
}

function getCurrentSessionFromParisHour(hour) {
  const tokyo = hour >= 1 && hour < 10;
  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const overlap = london && newYork;

  if (overlap) return "London+NewYork";
  if (london) return "London";
  if (newYork) return "NewYork";
  if (tokyo) return "Tokyo";
  return "OffSession";
}

function safeArchiveDefaults() {
  return {
    pairWinRate: 50,
    pairExpectancy: 0,
    hourWinRate: 50,
    hourExpectancy: 0,
    sessionWinRate: 50,
    sessionExpectancy: 0,
    last20WinRate: 50,
    last20Expectancy: 0,
    sameDirectionWinRate: 50,
    sameDirectionExpectancy: 0,
    archiveConfidence: 0
  };
}

function getArchiveStatsForScan(pair, direction) {
  const pairStats = appState.archiveStatsCache?.[pair];
  if (!pairStats) {
    return safeArchiveDefaults();
  }

  const hour = getCurrentParisHour();
  const session = getCurrentSessionFromParisHour(hour);
  const dir = String(direction || "buy").toLowerCase();

  const dirStats = pairStats.directions?.[dir] || {};
  const sessionStats = pairStats.sessions?.[session] || {};
  const hourStats = pairStats.hours?.[String(hour)] || {};

  return {
    pairWinRate: Number(pairStats.pairWinRate ?? 50),
    pairExpectancy: Number(pairStats.pairExpectancy ?? 0),
    hourWinRate: Number(hourStats.winRate ?? 50),
    hourExpectancy: Number(hourStats.expectancy ?? 0),
    sessionWinRate: Number(sessionStats.winRate ?? 50),
    sessionExpectancy: Number(sessionStats.expectancy ?? 0),
    last20WinRate: Number(pairStats.last20WinRate ?? 50),
    last20Expectancy: Number(pairStats.last20Expectancy ?? 0),
    sameDirectionWinRate: Number(dirStats.winRate ?? 50),
    sameDirectionExpectancy: Number(dirStats.expectancy ?? 0),
    archiveConfidence: Number(pairStats.archiveConfidence ?? 0)
  };
}

function buildReasons(scan) {
  return [
    `Trend ${Math.round(scan.trendScore || 0)}`,
    `Timing ${Math.round(scan.timingScore || 0)}`,
    `Risk ${Math.round(scan.riskScore || 0)}`,
    `Context ${Math.round(scan.contextScore || 0)}`,
    `ML ${Math.round(scan.mlScore || 0)}`,
    `VectorBT ${Math.round(scan.vectorbtScore || 0)}`,
    `Archive WR ${Math.round(scan.archiveStats?.pairWinRate || 50)}%`,
    `Archive Exp ${Number(scan.archiveStats?.pairExpectancy || 0).toFixed(2)}R`,
    `Dir WR ${Math.round(scan.archiveStats?.sameDirectionWinRate || 50)}%`,
    `Session WR ${Math.round(scan.archiveStats?.sessionWinRate || 50)}%`
  ];
}

function inferInitialSignal(finalScore) {
  if (finalScore >= 70) return "BUY";
  if (finalScore <= 35) return "SELL";
  return "WAIT";
}

export async function scanPair(pair) {
  let candles = [];
  let marketPayload = null;

  try {
    marketPayload = await fetchMarketCandles(pair.symbol, appState.timeframe);

    candles = Array.isArray(marketPayload?.candles) && marketPayload.candles.length
      ? normalizeCandles(marketPayload.candles)
      : generateFakeCandles(pair.symbol);
  } catch {
    candles = generateFakeCandles(pair.symbol);
  }

  const closes = candles.map((c) => Number(c.close || 0));
  const highs = candles.map((c) => Number(c.high || 0));
  const lows = candles.map((c) => Number(c.low || 0));

  const current = closes.at(-1) || 0;
  const ema20Series = emaSeries(closes, 20);
  const ema50Series = emaSeries(closes, 50);
  const ema20 = ema20Series.at(-1) || current;
  const ema50 = ema50Series.at(-1) || current;
  const rsi14 = Number(marketPayload?.indicators?.rsi14 ?? rsi(closes, 14));
  const atr14 = Number(marketPayload?.indicators?.atr14 ?? atr(highs, lows, closes, 14));
  const macdLine = Number(
    marketPayload?.indicators?.macd ??
    ((emaSeries(closes, 12).at(-1) || 0) - (emaSeries(closes, 26).at(-1) || 0))
  );
  const momentum = Number(marketPayload?.indicators?.momentum ?? computeMomentum(closes, 12));

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
    72 -
      (pair.symbol === "XAUUSD" ? 8 : 0) -
      (pair.symbol.includes("JPY") ? 2 : 0) -
      (pair.symbol.startsWith("GBP") ? 1 : 0),
    1,
    99
  );

  const contextScore = clamp(
    50 +
      (pair.tier === 1 ? 8 : pair.tier === 2 ? 3 : -2) +
      (marketPayload?.source === "d1-primary" ? 4 : 0),
    1,
    99
  );

  const atrFallback = atr14 || current * (pair.symbol === "XAUUSD" ? 0.0022 : 0.002);
  const stopLoss =
    pair.symbol === "XAUUSD"
      ? current - atrFallback * 1.55
      : current - atrFallback * 1.4;

  const takeProfit =
    pair.symbol === "XAUUSD"
      ? current + atrFallback * 2.8
      : current + atrFallback * 2.6;

  const rr = Math.abs((takeProfit - current) / ((current - stopLoss) || 0.00001));

  const scan = {
    pair: pair.symbol,
    group: pair.group,
    tier: pair.tier,
    timeframe: appState.timeframe,
    source: marketPayload?.source || "local-fallback",
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
    reason: "Analyse consolidée",
    entryTriggerScore: clamp(
      timingScore * 0.55 + trendScore * 0.25 + contextScore * 0.20,
      1,
      99
    ),
    entrySniper: {
      score: clamp(
        timingScore * 0.50 + riskScore * 0.20 + contextScore * 0.30,
        1,
        99
      ),
      quality: "neutral",
      action: "WAIT",
      reason: "No sniper validation yet."
    },
    exitSniper: {
      score: 50,
      quality: "neutral",
      action: "HOLD",
      reason: "Neutral."
    },
    spreadPenalty: 0,
    offSessionPenalty: 0,
    macroPenalty: 0,
    mlScore: 50,
    vectorbtScore: 50
  };

  const initialSignal = inferInitialSignal(
    clamp(
      Math.round(
        trendScore * 0.30 +
        timingScore * 0.24 +
        contextScore * 0.18 +
        riskScore * 0.16 +
        scan.entryTriggerScore * 0.12
      ),
      1,
      99
    )
  );

  scan.signal = initialSignal;
  scan.direction = initialSignal === "SELL" ? "sell" : "buy";
  scan.archiveStats = getArchiveStatsForScan(scan.pair, scan.direction);

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

  scan.signal = inferInitialSignal(scan.finalScore);
  scan.direction = scan.signal === "SELL" ? "sell" : "buy";
  scan.archiveStats = getArchiveStatsForScan(scan.pair, scan.direction);

  const ultra = computeUltraScore(scan);

  scan.ultraScore = ultra.ultraScore;
  scan.ultraGrade = ultra.grade;
  scan.smartMoneyScore = ultra.smartMoney;
  scan.sessionScore = ultra.session;
  scan.executionScore = ultra.execution;
  scan.entryPrecisionScore = ultra.entryPrecision;
  scan.momentumQuality = ultra.momentumQuality;
  scan.spreadScore = ultra.spreadScore;
  scan.archiveEdgeScore = ultra.archiveEdge;
  scan.goldStructureScore = ultra.goldStructure;
  scan.goldDangerScore = ultra.goldDanger;

  const filterDecision = getTradeFilterDecision(scan);

  scan.tradeAllowed = filterDecision.allowed;
  scan.tradeStatus = filterDecision.status;
  scan.tradeReason = filterDecision.reason;

  if (!scan.tradeAllowed) {
    scan.signal = "WAIT";
  }

  scan.reason =
    scan.tradeReason ||
    scan.mlExplanation ||
    scan.vectorbtExplanation ||
    "Analyse consolidée";

  scan.reasons = buildReasons(scan);

  return scan;
}

export function computeHedgeScore(scan) {
  return Math.round(
    Number(scan.trendScore || 0) * 0.25 +
      Number(scan.timingScore || 0) * 0.20 +
      Number(scan.contextScore || 0) * 0.15 +
      Number(scan.riskScore || 0) * 0.10 +
      Number(scan.mlScore || 0) * 0.15 +
      Number(scan.vectorbtScore || 0) * 0.15
  );
}

export function isEliteTrade(scan) {
  return (
    Number(scan.ultraScore || 0) >= 82 &&
    Number(scan.archiveEdgeScore || 0) >= 58 &&
    Number(scan.executionScore || 0) >= 58
  );
}

export function computeConfluenceScore(scan) {
  const score = Math.round(
    Number(scan.ultraScore || scan.finalScore || 0) * 0.42 +
      Number(scan.archiveEdgeScore || 0) * 0.18 +
      Number(scan.executionScore || 0) * 0.14 +
      Number(scan.sessionScore || 0) * 0.10 +
      Number(scan.mlScore || 0) * 0.08 +
      Number(scan.vectorbtScore || 0) * 0.08
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
