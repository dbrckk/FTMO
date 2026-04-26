export function classifySetup(input = {}) {
  const pair = String(input.pair || "").toUpperCase();
  const timeframe = String(input.timeframe || "M15").toUpperCase();
  const candles = Array.isArray(input.candles) ? input.candles : [];
  const direction = String(input.direction || "wait").toLowerCase();
  const signal = String(input.signal || "WAIT").toUpperCase();

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
      lateImpulse: false,
      reasons: ["No valid directional setup"],
      blockers: ["No BUY/SELL direction"]
    };
  }

  const closes = candles.map((c) => Number(c.close || 0)).filter(Number.isFinite);
  const highs = candles.map((c) => Number(c.high || 0)).filter(Number.isFinite);
  const lows = candles.map((c) => Number(c.low || 0)).filter(Number.isFinite);

  const current = Number(input.current || closes.at(-1) || 0);
  const last = candles.at(-1);
  const prev = candles.at(-2);

  const ema20Value = ema(closes, 20);
  const ema50Value = ema(closes, 50);
  const atrValue = Number(input.atr14 || atr(highs, lows, closes, 14));
  const volatility = Number(input.volatility || computeVolatility(closes, 30));
  const momentum = Number(input.momentum || computeMomentum(closes, 12));
  const rsi14 = Number(input.rsi14 || 50);

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

  const wickRiskScore = computeWickRiskScore({
    direction,
    upperWickRatio,
    lowerWickRatio,
    bodyRatio
  });

  let setupType = "weak-signal";
  let triggerType = "none";
  let entryModel = "none";
  let score = 48;
  const reasons = [];
  const blockers = [];

  if (buyPullback || sellPullback) {
    setupType = "trend-pullback";
    triggerType = "ema-reclaim";
    entryModel = "pullback-confirmation";
    score += 26;
    reasons.push("Trend pullback confirmed near EMA20");
  } else if (buyBreakout || sellBreakout) {
    setupType = "breakout-continuation";
    triggerType = "range-break";
    entryModel = "breakout-confirmation";
    score += 22;
    reasons.push("Breakout continuation confirmed");
  } else if (buyRejection || sellRejection) {
    setupType = "liquidity-rejection";
    triggerType = "wick-rejection";
    entryModel = "rejection-confirmation";
    score += 20;
    reasons.push("Liquidity rejection candle confirmed");
  } else if (
    (direction === "buy" && trendUp && momentum > 0 && bodyRatio >= 0.45) ||
    (direction === "sell" && trendDown && momentum < 0 && bodyRatio >= 0.45)
  ) {
    setupType = "momentum-continuation";
    triggerType = "momentum-candle";
    entryModel = "momentum-confirmation";
    score += 16;
    reasons.push("Momentum continuation confirmed");
  } else if (trendRegime === "range") {
    setupType = "range-signal";
    triggerType = "range";
    entryModel = "range-risk";
    score -= 8;
    blockers.push("Range environment");
  }

  if (signal === "BUY" || signal === "SELL") {
    score += 4;
    reasons.push("Directional scanner signal active");
  }

  if (trendRegime === "uptrend" && direction === "buy") score += 7;
  if (trendRegime === "downtrend" && direction === "sell") score += 7;
  if (trendRegime === "mixed") score -= 5;
  if (trendRegime === "range") score -= 8;

  if (bodyRatio >= 0.48 && bodyRatio <= 0.82) {
    score += 7;
    reasons.push("Healthy candle body");
  }

  if (wickRiskScore >= 65) {
    score -= 10;
    blockers.push("Dangerous opposite wick");
  }

  if (lateImpulse) {
    setupType = "late-impulse";
    triggerType = "late";
    entryModel = "avoid-late-entry";
    score -= 24;
    blockers.push("Late impulse entry");
  } else if (distanceEma20Atr <= 1.2) {
    score += 7;
    reasons.push("Entry close to EMA20");
  } else if (distanceEma20Atr <= 2.0) {
    score += 2;
    reasons.push("Entry distance acceptable");
  } else {
    score -= 8;
    blockers.push("Entry far from EMA20");
  }

  if (volatilityRegime === "normal") {
    score += 5;
    reasons.push("Volatility normal");
  } else if (volatilityRegime === "quiet") {
    score -= 3;
    reasons.push("Volatility quiet");
  } else if (volatilityRegime === "elevated") {
    score -= pair === "BTCUSD" || pair === "XAUUSD" ? 7 : 5;
    blockers.push("Volatility elevated");
  } else if (volatilityRegime === "extreme") {
    score -= 18;
    blockers.push("Volatility extreme");
  }

  if (direction === "buy" && rsi14 > 74) {
    score -= 10;
    blockers.push("RSI extended for BUY");
  }

  if (direction === "sell" && rsi14 < 26) {
    score -= 10;
    blockers.push("RSI extended for SELL");
  }

  if (timeframe === "H1" || timeframe === "H4") score += 2;
  if (timeframe === "M5") score -= 4;

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
    lateImpulse,
    reasons,
    blockers
  };
}

function computeWickRiskScore(data) {
  let score = 30;

  if (data.direction === "buy") {
    score += data.upperWickRatio * 90;
    if (data.lowerWickRatio > 0.32) score -= 10;
  }

  if (data.direction === "sell") {
    score += data.lowerWickRatio * 90;
    if (data.upperWickRatio > 0.32) score -= 10;
  }

  if (data.bodyRatio < 0.25) score += 10;

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

function clamp(value, min = 1, max = 99) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;

  return Math.max(min, Math.min(max, n));
}
