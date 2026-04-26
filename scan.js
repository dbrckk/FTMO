import { API } from "./config.js";
import { appState } from "./state.js";
import { fetchMlScore, fetchVectorbtScore } from "./api.js";

const MARKET_TIMEOUT_MS = 12000;
const MIN_CANDLES = 60;

export async function scanPair(pairEntry) {
  const pair = getPairSymbol(pairEntry);
  const timeframe = appState.timeframe || "M15";

  try {
    const candles = await fetchMarketCandles(pair, timeframe);

    if (!candles.length || candles.length < MIN_CANDLES) {
      return buildFallbackScan(pair, timeframe, candles, "Not enough candles.");
    }

    const local = buildLocalScan(pair, timeframe, candles);
    const archive = getArchiveStats(pair);
    const archivePack = applyArchiveLearning(local, archive);

    const ml = await fetchMlScore({
      ...local,
      ...archivePack,
      candles
    });

    const vectorbt = await fetchVectorbtScore({
      ...local,
      ...archivePack,
      candles
    });

    const enriched = {
      ...local,
      ...archivePack,
      mlScore: Number(ml?.mlScore || 50),
      mlConfidenceBand: ml?.confidenceBand || "medium",
      mlNotes: Array.isArray(ml?.notes) ? ml.notes : [],
      vectorbtScore: Number(vectorbt?.vectorbtScore || 55),
      vectorbtConfidenceBand: vectorbt?.confidenceBand || "medium",
      vectorbtMetrics: vectorbt?.metrics || null,
      vectorbtNotes: Array.isArray(vectorbt?.notes) ? vectorbt.notes : []
    };

    const ultraScore = computeUltraScore(enriched);
    const entryQuality = computeEntryQualityScore({
      ...enriched,
      ultraScore
    });

    const exitPressure = computeExitPressureScore({
      ...enriched,
      ultraScore,
      entryQualityScore: entryQuality.score
    });

    const lateEntry = isLateEntry({
      ...enriched,
      ultraScore
    });

    const paperScore = computePaperScore({
      ...enriched,
      ultraScore,
      entryQualityScore: entryQuality.score,
      exitPressureScore: exitPressure.score
    });

    const decision = buildTradeDecision({
      ...enriched,
      ultraScore,
      entryQualityScore: entryQuality.score,
      entryQualityLabel: entryQuality.label,
      entryQualityReasons: entryQuality.reasons,
      exitPressureScore: exitPressure.score,
      exitPressureLabel: exitPressure.label,
      lateEntry,
      paperScore
    });

    return {
      ...enriched,

      ultraScore: Math.round(ultraScore),
      ultraGrade: getUltraGrade(ultraScore),

      entryQualityScore: entryQuality.score,
      entryQualityLabel: entryQuality.label,
      entryQualityReasons: entryQuality.reasons,

      exitPressureScore: exitPressure.score,
      exitPressureLabel: exitPressure.label,

      lateEntry,
      paperScore: Math.round(paperScore),

      tradeAllowed: decision.allowed,
      tradeStatus: decision.status,
      tradeReason: decision.reason,

      reasons: [
        ...enriched.reasons,
        ...entryQuality.reasons.map((reason) => `Entry: ${reason}`),
        `Exit pressure: ${exitPressure.score}/100`,
        `Paper score: ${Math.round(paperScore)}/100`,
        decision.reason
      ].filter(Boolean)
    };
  } catch (error) {
    return buildFallbackScan(
      pair,
      timeframe,
      [],
      String(error?.message || error || "scan error")
    );
  }
}

async function fetchMarketCandles(pair, timeframe) {
  const endpoint = API.marketData || "/api/market-data";
  const url = new URL(endpoint, window.location.origin);

  url.searchParams.set("pair", pair);
  url.searchParams.set("timeframe", timeframe);
  url.searchParams.set("limit", "260");

  const response = await fetchWithTimeout(url.toString(), MARKET_TIMEOUT_MS);
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `market-data ${response.status}`);
  }

  const rows = Array.isArray(data.candles) ? data.candles : [];

  return rows
    .map(normalizeCandle)
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function buildLocalScan(pair, timeframe, candles) {
  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);

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

  const direction = computeDirection({
    current,
    ema20Value,
    ema50Value,
    momentum,
    rsi14
  });

  const signal =
    direction === "buy"
      ? "BUY"
      : direction === "sell"
        ? "SELL"
        : "WAIT";

  const trendScore = computeTrendScore({
    current,
    ema20Value,
    ema50Value,
    ema100Value,
    momentum,
    direction
  });

  const timingScore = computeTimingScore({
    current,
    previous,
    rsi14,
    macdLine,
    momentum,
    direction
  });

  const riskScore = computeRiskScore({
    pair,
    volatility,
    atr14,
    current
  });

  const sessionScore = computeSessionScore(pair);
  const executionScore = computeExecutionScore(candles, direction, atr14);
  const smartMoneyScore = computeSmartMoneyScore(candles, direction);
  const contextScore = computeContextScore({
    pair,
    timeframe,
    volatility,
    trendScore,
    timingScore,
    sessionScore
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

  const localScore = clamp(
    trendScore * 0.25 +
      timingScore * 0.20 +
      riskScore * 0.14 +
      executionScore * 0.15 +
      smartMoneyScore * 0.10 +
      contextScore * 0.08 +
      sessionScore * 0.08,
    1,
    99
  );

  return {
    pair,
    timeframe,
    candles,
    current: roundByPair(current, pair),
    previous: roundByPair(previous, pair),

    direction,
    signal,

    finalScore: Math.round(localScore),
    localScore: Math.round(localScore),

    trendScore: Math.round(trendScore),
    timingScore: Math.round(timingScore),
    riskScore: Math.round(riskScore),
    contextScore: Math.round(contextScore),
    smartMoneyScore: Math.round(smartMoneyScore),
    sessionScore: Math.round(sessionScore),
    executionScore: Math.round(executionScore),

    rsi14: round(rsi14, 2),
    atr14: roundByPair(atr14, pair),
    momentum: round(momentum, 3),
    volatility: round(volatility, 6),
    macdLine: round(macdLine, 6),

    rr,
    stopLoss: roundByPair(stopLoss, pair),
    takeProfit: roundByPair(takeProfit, pair),

    reasons: buildBaseReasons({
      signal,
      trendScore,
      timingScore,
      riskScore,
      executionScore,
      smartMoneyScore,
      sessionScore
    })
  };
}

function applyArchiveLearning(scan, archive) {
  const directionStats = getDirectionArchive(archive, scan.direction);

  const confidence =
    archive.trades >= 50 ? 1 :
    archive.trades >= 25 ? 0.82 :
    archive.trades >= 10 ? 0.62 :
    archive.trades >= 4 ? 0.42 :
    0.25;

  const pairScore =
    scoreWinRate(archive.winRate) * 0.42 +
    scoreExpectancy(archive.expectancy) * 0.58;

  const directionScore =
    scoreWinRate(directionStats.winRate) * 0.42 +
    scoreExpectancy(directionStats.expectancy) * 0.58;

  let archiveEdgeScore = pairScore * 0.42 + directionScore * 0.58;
  archiveEdgeScore = 50 + (archiveEdgeScore - 50) * confidence;

  const archivePenalty =
    archive.trades >= 12 &&
    archive.expectancy < -0.18 &&
    directionStats.expectancy < -0.12;

  return {
    archiveStats: archive,
    archiveConfidence: Math.round(confidence * 100),
    archiveEdgeScore: Math.round(clamp(archiveEdgeScore, 1, 99)),
    archivePenalty,
    archiveDirectionTrades: directionStats.trades,
    archiveDirectionExpectancy: Number(directionStats.expectancy || 0)
  };
}

function computeUltraScore(scan) {
  let score = clamp(
    Number(scan.localScore || 50) * 0.22 +
      Number(scan.mlScore || 50) * 0.18 +
      Number(scan.vectorbtScore || 55) * 0.16 +
      Number(scan.trendScore || 50) * 0.12 +
      Number(scan.timingScore || 50) * 0.10 +
      Number(scan.executionScore || 50) * 0.10 +
      Number(scan.riskScore || 50) * 0.06 +
      Number(scan.archiveEdgeScore || 50) * 0.06,
    1,
    99
  );

  if (scan.signal === "WAIT") score -= 16;
  if (scan.archivePenalty) score -= 10;

  if (scan.pair === "BTCUSD") {
    score -= 3;

    if (scan.timeframe === "H1" || scan.timeframe === "H4") score += 3;
    if (scan.volatility >= 0.003 && scan.volatility <= 0.02) score += 4;
    if (scan.volatility > 0.04) score -= 12;
  }

  if (scan.pair === "XAUUSD") {
    if (scan.timeframe === "H1" || scan.timeframe === "H4") score += 2;
    if (scan.volatility > 0.025) score -= 8;
  }

  return clamp(score, 1, 99);
}

function computeEntryQualityScore(scan) {
  if (scan.direction !== "buy" && scan.direction !== "sell") {
    return {
      score: 0,
      label: "no-direction",
      reasons: ["No direction"]
    };
  }

  let score = 50;
  const reasons = [];

  score += (Number(scan.ultraScore || 0) - 70) * 0.22;
  score += (Number(scan.trendScore || 50) - 50) * 0.16;
  score += (Number(scan.timingScore || 50) - 50) * 0.17;
  score += (Number(scan.executionScore || 50) - 50) * 0.18;
  score += (Number(scan.smartMoneyScore || 50) - 50) * 0.10;
  score += (Number(scan.archiveEdgeScore || 50) - 50) * 0.10;
  score += (Number(scan.riskScore || 50) - 50) * 0.07;

  const trigger = computeCandleTriggerScore(scan.candles, scan.direction);
  score += trigger.score;
  reasons.push(...trigger.reasons);

  const extension = computeLateEntryPenalty(scan);
  score -= extension.penalty;
  reasons.push(...extension.reasons);

  if (scan.signal === "BUY" || scan.signal === "SELL") {
    score += 4;
    reasons.push("Directional signal active");
  }

  if (scan.rsi14 > 74 && scan.direction === "buy") {
    score -= scan.pair === "BTCUSD" ? 10 : 7;
    reasons.push("RSI buy extended");
  }

  if (scan.rsi14 < 26 && scan.direction === "sell") {
    score -= scan.pair === "BTCUSD" ? 10 : 7;
    reasons.push("RSI sell extended");
  }

  if (scan.archivePenalty) {
    score -= 8;
    reasons.push("Archive negative expectancy");
  }

  if (scan.pair === "BTCUSD") {
    score -= 3;
    reasons.push("BTC risk discount");
  }

  if (scan.pair === "XAUUSD") {
    score -= 1;
  }

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

function computeExitPressureScore(scan) {
  let score = 28;

  score += weakness(scan.trendScore, 50) * 0.20;
  score += weakness(scan.timingScore, 48) * 0.18;
  score += weakness(scan.executionScore, 48) * 0.18;
  score += weakness(scan.smartMoneyScore, 48) * 0.12;
  score += weakness(scan.riskScore, 44) * 0.12;
  score += weakness(scan.archiveEdgeScore, 45) * 0.08;

  if (scan.signal === "WAIT") score += 10;
  if (scan.archivePenalty) score += 8;

  if (scan.pair === "BTCUSD") {
    if (scan.volatility > 0.035) score += 12;
    if (Math.abs(scan.momentum) > 7) score += 8;
  }

  if (scan.pair === "XAUUSD") {
    if (scan.volatility > 0.025) score += 10;
    if (Math.abs(scan.momentum) > 3.2) score += 6;
  }

  if (scan.ultraScore >= 82 && scan.executionScore >= 62) {
    score -= 8;
  }

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

function computePaperScore(scan) {
  return clamp(
    Number(scan.ultraScore || 0) * 0.30 +
      Number(scan.entryQualityScore || 0) * 0.25 +
      Number(scan.archiveEdgeScore || 50) * 0.14 +
      Number(scan.executionScore || 50) * 0.10 +
      Number(scan.smartMoneyScore || 50) * 0.08 +
      Number(scan.riskScore || 50) * 0.06 +
      Number(scan.sessionScore || 50) * 0.03 +
      (100 - Number(scan.exitPressureScore || 50)) * 0.04,
    1,
    99
  );
}

function buildTradeDecision(scan) {
  const minUltra =
    scan.pair === "BTCUSD" ? 74 :
    scan.pair === "XAUUSD" ? 72 :
    70;

  const minEntry =
    scan.pair === "BTCUSD" ? 70 :
    scan.pair === "XAUUSD" ? 68 :
    66;

  const minRisk =
    scan.pair === "BTCUSD" ? 44 :
    scan.pair === "XAUUSD" ? 43 :
    42;

  if (scan.signal === "WAIT") {
    return {
      allowed: false,
      status: "WAIT",
      reason: "No directional signal."
    };
  }

  if (scan.ultraScore < minUltra) {
    return {
      allowed: false,
      status: "BLOCKED SCORE",
      reason: `Ultra score too weak: ${Math.round(scan.ultraScore)}/100.`
    };
  }

  if (scan.entryQualityScore < minEntry) {
    return {
      allowed: false,
      status: "BLOCKED ENTRY",
      reason: `Entry quality too weak: ${Math.round(scan.entryQualityScore)}/100.`
    };
  }

  if (scan.exitPressureScore >= 68) {
    return {
      allowed: false,
      status: "BLOCKED EXIT",
      reason: `Exit pressure too high: ${Math.round(scan.exitPressureScore)}/100.`
    };
  }

  if (scan.lateEntry) {
    return {
      allowed: false,
      status: "BLOCKED LATE",
      reason: "Entry is too late after impulse."
    };
  }

  if (scan.riskScore < minRisk) {
    return {
      allowed: false,
      status: "BLOCKED RISK",
      reason: `Risk score too weak: ${Math.round(scan.riskScore)}/100.`
    };
  }

  if (scan.archivePenalty) {
    return {
      allowed: false,
      status: "BLOCKED ARCHIVE",
      reason: "Archive expectancy is negative for this setup."
    };
  }

  return {
    allowed: true,
    status:
      scan.pair === "BTCUSD"
        ? "VALID BTC V4"
        : scan.pair === "XAUUSD"
          ? "VALID GOLD V4"
          : "VALID V4",
    reason: "Entry quality, score, risk and exit pressure accepted."
  };
}

function computeDirection(data) {
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

  if (data.direction === "buy" && data.current > data.ema20Value && data.ema20Value > data.ema50Value) {
    score += 8;
  }

  if (data.direction === "sell" && data.current < data.ema20Value && data.ema20Value < data.ema50Value) {
    score += 8;
  }

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

function computeRiskScore(data) {
  const pair = String(data.pair || "").toUpperCase();
  const volatility = Number(data.volatility || 0);

  let score = 76;

  score -= Math.min(22, volatility * 900);

  if (pair === "BTCUSD") score -= 10;
  if (pair === "XAUUSD") score -= 8;
  if (pair.startsWith("GBP")) score -= 2;

  if (data.atr14 && data.current) {
    const atrPercent = data.atr14 / data.current;

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

function computeContextScore(data) {
  let score = 50;

  score += (Number(data.trendScore || 50) - 50) * 0.25;
  score += (Number(data.timingScore || 50) - 50) * 0.18;
  score += (Number(data.sessionScore || 50) - 50) * 0.18;

  if (data.timeframe === "H1" || data.timeframe === "H4") score += 3;
  if (data.timeframe === "M5") score -= 4;

  if (data.pair === "BTCUSD" && data.volatility > 0.04) score -= 10;
  if (data.pair === "XAUUSD" && data.volatility > 0.025) score -= 8;

  return clamp(score, 1, 99);
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

function computeCandleTriggerScore(candles, direction) {
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const recent = candles.slice(-14);

  const avgRange = average(recent.map((c) => Number(c.high || 0) - Number(c.low || 0)));
  const range = Math.max(0.0000001, Number(last.high || 0) - Number(last.low || 0));
  const body = Math.abs(Number(last.close || 0) - Number(last.open || 0));
  const bodyRatio = body / range;

  let score = 0;
  const reasons = [];

  if (direction === "buy") {
    if (last.close > last.open) {
      score += 5;
      reasons.push("Bull candle");
    }

    if (last.close > prev.high) {
      score += 8;
      reasons.push("Buy breakout");
    }

    if (last.close > last.low + range * 0.68) {
      score += 5;
      reasons.push("Close near high");
    }

    if (last.low >= prev.low) {
      score += 3;
      reasons.push("Higher low");
    }
  }

  if (direction === "sell") {
    if (last.close < last.open) {
      score += 5;
      reasons.push("Bear candle");
    }

    if (last.close < prev.low) {
      score += 8;
      reasons.push("Sell breakdown");
    }

    if (last.close < last.high - range * 0.68) {
      score += 5;
      reasons.push("Close near low");
    }

    if (last.high <= prev.high) {
      score += 3;
      reasons.push("Lower high");
    }
  }

  if (bodyRatio >= 0.52 && bodyRatio <= 0.82) {
    score += 5;
    reasons.push("Healthy impulse");
  }

  if (avgRange > 0 && range > avgRange * 2.4) {
    score -= 12;
    reasons.push("Impulse too large");
  }

  return {
    score,
    reasons
  };
}

function computeLateEntryPenalty(scan) {
  const candles = scan.candles || [];
  const closes = candles.map((c) => Number(c.close || 0)).filter(Number.isFinite);
  const highs = candles.map((c) => Number(c.high || 0)).filter(Number.isFinite);
  const lows = candles.map((c) => Number(c.low || 0)).filter(Number.isFinite);

  const current = Number(scan.current || closes.at(-1) || 0);
  const ema20Value = ema(closes, 20);
  const atrValue = Number(scan.atr14 || atr(highs, lows, closes, 14));

  if (!current || !ema20Value || !atrValue) {
    return {
      penalty: 0,
      reasons: []
    };
  }

  const distance = Math.abs(current - ema20Value);

  const maxDistance =
    scan.pair === "BTCUSD" ? atrValue * 2.8 :
    scan.pair === "XAUUSD" ? atrValue * 2.4 :
    atrValue * 2.1;

  if (distance > maxDistance) {
    return {
      penalty: 14,
      reasons: ["Late entry distance"]
    };
  }

  if (distance > maxDistance * 0.75) {
    return {
      penalty: 6,
      reasons: ["Entry slightly extended"]
    };
  }

  return {
    penalty: 0,
    reasons: []
  };
}

function isLateEntry(scan) {
  const late = computeLateEntryPenalty(scan);
  return late.penalty >= 14;
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

function buildBaseReasons(data) {
  const reasons = [];

  reasons.push(`Signal ${data.signal}`);

  if (data.trendScore >= 65) reasons.push("Trend confirmed");
  else if (data.trendScore < 45) reasons.push("Trend weak");

  if (data.timingScore >= 65) reasons.push("Timing favorable");
  else if (data.timingScore < 45) reasons.push("Timing weak");

  if (data.executionScore >= 65) reasons.push("Execution candle clean");
  else if (data.executionScore < 45) reasons.push("Execution weak");

  if (data.riskScore >= 60) reasons.push("Risk acceptable");
  else if (data.riskScore < 45) reasons.push("Risk elevated");

  if (data.smartMoneyScore >= 62) reasons.push("Smart flow supportive");

  return reasons;
}

function getArchiveStats(pair) {
  const cache = appState.archiveStatsCache || {};
  const stats = cache[pair] || {};

  return {
    trades: Number(stats.pairTradesCount || stats.trades || 0),
    wins: Number(stats.wins || 0),
    winRate: Number(stats.pairWinRate || stats.winRate || 50),
    expectancy: Number(stats.pairExpectancy || stats.expectancy || 0),
    pnlR: Number(stats.pairPnlR || stats.pnlR || 0),
    directions: {
      buy: normalizeArchiveSide(stats.directions?.buy),
      sell: normalizeArchiveSide(stats.directions?.sell)
    }
  };
}

function normalizeArchiveSide(side) {
  return {
    trades: Number(side?.trades || 0),
    wins: Number(side?.wins || 0),
    winRate: Number(side?.winRate || 50),
    expectancy: Number(side?.expectancy || 0)
  };
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

export function computeConfluenceScore(scan) {
  const score = clamp(
    Number(scan.ultraScore || scan.finalScore || 0) * 0.35 +
      Number(scan.entryQualityScore || 0) * 0.22 +
      Number(scan.trendScore || 0) * 0.14 +
      Number(scan.timingScore || 0) * 0.12 +
      Number(scan.archiveEdgeScore || 50) * 0.10 +
      Number(scan.executionScore || 50) * 0.07,
    1,
    99
  );

  return {
    score: Math.round(score),
    label:
      score >= 84 ? "Elite confluence" :
      score >= 72 ? "Strong confluence" :
      score >= 60 ? "Medium confluence" :
      "Weak confluence"
  };
}

export function computeHedgeScore(scan) {
  const pair = String(scan?.pair || "").toUpperCase();
  let score = 50;

  if (pair === "BTCUSD") score -= 10;
  if (pair === "XAUUSD") score -= 8;
  if (pair.includes("USD")) score -= 4;
  if (pair.includes("JPY")) score -= 2;
  if (Number(scan?.riskScore || 50) >= 60) score += 8;
  if (Number(scan?.exitPressureScore || 0) >= 68) score -= 10;

  return Math.round(clamp(score, 1, 99));
}

export function isEliteTrade(scan) {
  return Boolean(
    scan?.tradeAllowed &&
    Number(scan?.ultraScore || 0) >= 82 &&
    Number(scan?.entryQualityScore || 0) >= 76 &&
    Number(scan?.exitPressureScore || 99) < 58 &&
    Number(scan?.riskScore || 0) >= 48
  );
}

function buildFallbackScan(pair, timeframe, candles = [], reason = "No data") {
  return {
    pair,
    timeframe,
    candles,
    current: Number(candles.at(-1)?.close || 0),
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

    entryQualityScore: 0,
    entryQualityLabel: "no-data",
    entryQualityReasons: [reason],

    exitPressureScore: 99,
    exitPressureLabel: "no-data",

    rsi14: 50,
    atr14: 0,
    momentum: 0,
    volatility: 0,
    macdLine: 0,

    rr: getDefaultRr(pair),
    stopLoss: 0,
    takeProfit: 0,

    tradeAllowed: false,
    tradeStatus: "NO DATA",
    tradeReason: reason,
    reason,
    reasons: [reason],
    paperScore: 0
  };
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

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
}

function getPairSymbol(pairEntry) {
  if (typeof pairEntry === "string") {
    return pairEntry.toUpperCase();
  }

  return String(pairEntry?.symbol || "UNKNOWN").toUpperCase();
}

function getUltraGrade(score) {
  const value = Number(score || 0);

  if (value >= 90) return "A++";
  if (value >= 84) return "A+";
  if (value >= 78) return "A";
  if (value >= 70) return "B";
  if (value >= 60) return "C";

  return "D";
}

function getDefaultRr(pair) {
  const p = String(pair || "").toUpperCase();

  if (p === "BTCUSD") return 2.1;
  if (p === "XAUUSD") return 2.2;

  return 2;
}

function scoreWinRate(winRate) {
  return clamp(50 + (Number(winRate || 50) - 50) * 1.35, 1, 99);
}

function scoreExpectancy(expectancy) {
  return clamp(50 + Number(expectancy || 0) * 38, 1, 99);
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

function inferHour(date = new Date()) {
  return Number(
    new Date(date).toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );
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
