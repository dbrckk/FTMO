const MODEL_VERSION = "vectorbt-score-btc-v3";

export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const scan = normalizeScan(body.scan || body);

    if (!scan.pair) {
      return json({
        ok: false,
        error: "Missing pair",
        vectorbtScore: 50,
        confidenceBand: "fallback",
        metrics: null
      }, 400);
    }

    const result = scoreVectorbt(scan);

    return json({
      ok: true,
      source: "vectorbt-score",
      version: MODEL_VERSION,
      pair: scan.pair,
      timeframe: scan.timeframe,
      ...result
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "vectorbt-score-error"),
      vectorbtScore: 50,
      confidenceBand: "fallback",
      metrics: null
    }, 500);
  }
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);

    const scan = normalizeScan({
      pair: url.searchParams.get("pair") || "EURUSD",
      timeframe: url.searchParams.get("timeframe") || "M15",
      signal: url.searchParams.get("signal") || "WAIT",
      ultraScore: url.searchParams.get("ultraScore") || 50,
      trendScore: url.searchParams.get("trendScore") || 50,
      timingScore: url.searchParams.get("timingScore") || 50,
      riskScore: url.searchParams.get("riskScore") || 50,
      archiveEdgeScore: url.searchParams.get("archiveEdgeScore") || 50,
      rr: url.searchParams.get("rr") || 2
    });

    const result = scoreVectorbt(scan);

    return json({
      ok: true,
      source: "vectorbt-score",
      version: MODEL_VERSION,
      pair: scan.pair,
      timeframe: scan.timeframe,
      ...result
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "vectorbt-score-get-error"),
      vectorbtScore: 50,
      confidenceBand: "fallback",
      metrics: null
    }, 500);
  }
}

function normalizeScan(input) {
  const pair = String(input.pair || "")
    .toUpperCase()
    .replace("/", "")
    .trim();

  const timeframe = normalizeTimeframe(input.timeframe) || "M15";
  const candles = Array.isArray(input.candles)
    ? input.candles.map(normalizeCandle).filter(Boolean)
    : [];

  return {
    pair,
    timeframe,
    candles,

    signal: String(input.signal || "WAIT").toUpperCase(),
    direction: String(input.direction || "").toLowerCase(),

    ultraScore: safeNumber(input.ultraScore, 50),
    finalScore: safeNumber(input.finalScore, 50),
    localScore: safeNumber(input.localScore, 50),

    trendScore: safeNumber(input.trendScore, 50),
    timingScore: safeNumber(input.timingScore, 50),
    riskScore: safeNumber(input.riskScore, 50),
    smartMoneyScore: safeNumber(input.smartMoneyScore, 50),
    executionScore: safeNumber(input.executionScore, 50),
    archiveEdgeScore: safeNumber(input.archiveEdgeScore, 50),

    rr: safeNumber(input.rr, getDefaultRr(pair)),
    volatility: safeNumber(input.volatility, 0),
    momentum: safeNumber(input.momentum, 0),
    rsi14: safeNumber(input.rsi14, 50)
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

function scoreVectorbt(scan) {
  const profile = getPairProfile(scan.pair);

  if (scan.candles.length >= 70) {
    const metrics = runLocalBacktest(scan, profile);
    const score = scoreBacktestMetrics(metrics, scan, profile);

    return {
      vectorbtScore: Math.round(score),
      confidenceBand: getConfidenceBand(score, metrics),
      modelBias: getModelBias(scan, score),
      metrics,
      notes: buildNotes(scan, score, metrics, true)
    };
  }

  const fallbackScore = scoreWithoutCandles(scan, profile);

  return {
    vectorbtScore: Math.round(fallbackScore),
    confidenceBand: getFallbackConfidenceBand(fallbackScore),
    modelBias: getModelBias(scan, fallbackScore),
    metrics: {
      mode: "fallback",
      trades: 0,
      winRate: 50,
      expectancy: 0,
      profitFactor: 0,
      maxDrawdownR: 0,
      averageR: 0,
      sampleQuality: "no-candles"
    },
    notes: buildNotes(scan, fallbackScore, null, false)
  };
}

function runLocalBacktest(scan, profile) {
  const candles = scan.candles;
  const trades = [];
  const maxBarsHold = getMaxBarsHold(scan.timeframe, scan.pair);
  const rr = safeNumber(scan.rr, profile.defaultRr);

  for (let i = 55; i < candles.length - 3; i += 1) {
    const slice = candles.slice(0, i + 1);
    const closes = slice.map((c) => c.close);
    const highs = slice.map((c) => c.high);
    const lows = slice.map((c) => c.low);

    const current = closes.at(-1);
    const ema20Value = ema(closes, 20);
    const ema50Value = ema(closes, 50);
    const rsiValue = rsi(closes, 14);
    const atrValue = atr(highs, lows, closes, 14);
    const momentum = computeMomentum(closes, 12);

    const signal = getBacktestSignal({
      current,
      ema20Value,
      ema50Value,
      rsiValue,
      momentum
    });

    if (signal === "WAIT") continue;

    const entry = current;
    const riskDistance = atrValue > 0
      ? atrValue * profile.atrMultiplier
      : entry * profile.fallbackRiskPercent;

    if (!riskDistance || !Number.isFinite(riskDistance)) continue;

    const stop =
      signal === "SELL"
        ? entry + riskDistance
        : entry - riskDistance;

    const target =
      signal === "SELL"
        ? entry - riskDistance * rr
        : entry + riskDistance * rr;

    const future = candles.slice(i + 1, i + 1 + maxBarsHold);

    if (!future.length) continue;

    const result = resolveTrade({
      direction: signal === "SELL" ? "sell" : "buy",
      entry,
      stop,
      target,
      future
    });

    trades.push({
      direction: signal === "SELL" ? "sell" : "buy",
      entry: roundByPair(entry, scan.pair),
      stop: roundByPair(stop, scan.pair),
      target: roundByPair(target, scan.pair),
      exit: roundByPair(result.exit, scan.pair),
      pnlR: round(result.pnlR, 3),
      reason: result.reason
    });

    i += Math.max(2, Math.floor(maxBarsHold / 3));
  }

  return buildMetrics(trades, scan, profile);
}

function getBacktestSignal(data) {
  const bullish =
    data.ema20Value > data.ema50Value &&
    data.current > data.ema20Value &&
    data.momentum > 0 &&
    data.rsiValue >= 45 &&
    data.rsiValue <= 72;

  const bearish =
    data.ema20Value < data.ema50Value &&
    data.current < data.ema20Value &&
    data.momentum < 0 &&
    data.rsiValue <= 55 &&
    data.rsiValue >= 25;

  if (bullish) return "BUY";
  if (bearish) return "SELL";

  return "WAIT";
}

function resolveTrade({ direction, entry, stop, target, future }) {
  for (const candle of future) {
    if (direction === "buy") {
      const hitStop = candle.low <= stop;
      const hitTarget = candle.high >= target;

      if (hitStop && hitTarget) {
        return {
          exit: stop,
          pnlR: -1,
          reason: "both-hit-stop-first"
        };
      }

      if (hitStop) {
        return {
          exit: stop,
          pnlR: -1,
          reason: "stop-loss"
        };
      }

      if (hitTarget) {
        return {
          exit: target,
          pnlR: Math.abs(target - entry) / Math.abs(entry - stop),
          reason: "take-profit"
        };
      }
    }

    if (direction === "sell") {
      const hitStop = candle.high >= stop;
      const hitTarget = candle.low <= target;

      if (hitStop && hitTarget) {
        return {
          exit: stop,
          pnlR: -1,
          reason: "both-hit-stop-first"
        };
      }

      if (hitStop) {
        return {
          exit: stop,
          pnlR: -1,
          reason: "stop-loss"
        };
      }

      if (hitTarget) {
        return {
          exit: target,
          pnlR: Math.abs(entry - target) / Math.abs(stop - entry),
          reason: "take-profit"
        };
      }
    }
  }

  const last = future.at(-1);
  const exit = Number(last.close || entry);
  const risk = Math.abs(entry - stop);

  const pnlR = direction === "buy"
    ? (exit - entry) / risk
    : (entry - exit) / risk;

  return {
    exit,
    pnlR,
    reason: "time-exit"
  };
}

function buildMetrics(trades, scan, profile) {
  const count = trades.length;

  if (!count) {
    return {
      mode: "local-vectorbt",
      trades: 0,
      winRate: 50,
      expectancy: 0,
      profitFactor: 0,
      maxDrawdownR: 0,
      averageR: 0,
      sampleQuality: "empty",
      recentExpectancy: 0,
      recentWinRate: 50,
      longTrades: 0,
      shortTrades: 0
    };
  }

  const wins = trades.filter((trade) => Number(trade.pnlR || 0) > 0);
  const losses = trades.filter((trade) => Number(trade.pnlR || 0) <= 0);

  const totalR = trades.reduce((sum, trade) => sum + Number(trade.pnlR || 0), 0);
  const grossWin = wins.reduce((sum, trade) => sum + Math.max(0, Number(trade.pnlR || 0)), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Math.min(0, Number(trade.pnlR || 0)), 0));

  const recent = trades.slice(-20);
  const recentWins = recent.filter((trade) => Number(trade.pnlR || 0) > 0);
  const recentR = recent.reduce((sum, trade) => sum + Number(trade.pnlR || 0), 0);

  return {
    mode: "local-vectorbt",
    pair: scan.pair,
    timeframe: scan.timeframe,
    trades: count,
    winRate: round((wins.length / count) * 100, 2),
    expectancy: round(totalR / count, 4),
    profitFactor: grossLoss > 0
      ? round(grossWin / grossLoss, 3)
      : grossWin > 0
        ? 99
        : 0,
    maxDrawdownR: round(computeMaxDrawdownR(trades), 3),
    averageR: round(totalR / count, 4),
    recentExpectancy: recent.length ? round(recentR / recent.length, 4) : 0,
    recentWinRate: recent.length ? round((recentWins.length / recent.length) * 100, 2) : 50,
    longTrades: trades.filter((trade) => trade.direction === "buy").length,
    shortTrades: trades.filter((trade) => trade.direction === "sell").length,
    sampleQuality: getSampleQuality(count, profile.type),
    lastTrades: trades.slice(-8)
  };
}

function computeMaxDrawdownR(trades) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const trade of trades) {
    equity += Number(trade.pnlR || 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }

  return Math.abs(maxDrawdown);
}

function scoreBacktestMetrics(metrics, scan, profile) {
  if (!metrics.trades) {
    return scoreWithoutCandles(scan, profile) - 6;
  }

  const sampleFactor =
    metrics.trades >= 35 ? 1 :
    metrics.trades >= 20 ? 0.86 :
    metrics.trades >= 10 ? 0.68 :
    0.48;

  const winRateScore = clamp(50 + (metrics.winRate - 50) * 1.35, 1, 99);
  const expectancyScore = clamp(50 + metrics.expectancy * 38, 1, 99);
  const recentScore = clamp(50 + metrics.recentExpectancy * 34, 1, 99);
  const profitFactorScore = clamp(45 + metrics.profitFactor * 14, 1, 99);
  const drawdownScore = clamp(84 - metrics.maxDrawdownR * 8, 1, 99);

  let raw =
    winRateScore * 0.22 +
    expectancyScore * 0.28 +
    recentScore * 0.18 +
    profitFactorScore * 0.16 +
    drawdownScore * 0.16;

  raw = 50 + (raw - 50) * sampleFactor;

  raw += (safeNumber(scan.trendScore, 50) - 50) * 0.08;
  raw += (safeNumber(scan.timingScore, 50) - 50) * 0.06;
  raw += (safeNumber(scan.archiveEdgeScore, 50) - 50) * 0.07;

  if (scan.signal === "WAIT") raw -= 10;

  if (profile.type === "crypto") {
    raw -= 3;

    if (metrics.trades >= 15 && metrics.expectancy > 0.15) raw += 5;
    if (metrics.maxDrawdownR > 5) raw -= 7;
    if (metrics.recentExpectancy < -0.1) raw -= 6;
  }

  if (profile.type === "gold") {
    if (metrics.expectancy > 0.1) raw += 2;
    if (metrics.maxDrawdownR > 4.5) raw -= 5;
  }

  return clamp(raw, 1, 99);
}

function scoreWithoutCandles(scan, profile) {
  let score = clamp(
    safeNumber(scan.ultraScore, 50) * 0.30 +
      safeNumber(scan.trendScore, 50) * 0.18 +
      safeNumber(scan.timingScore, 50) * 0.16 +
      safeNumber(scan.riskScore, 50) * 0.13 +
      safeNumber(scan.archiveEdgeScore, 50) * 0.15 +
      safeNumber(scan.executionScore, 50) * 0.08,
    1,
    99
  );

  if (scan.signal === "WAIT") score -= 12;
  if (profile.type === "crypto") score -= 4;
  if (profile.type === "gold") score += 1;

  return clamp(score, 1, 99);
}

function getPairProfile(pair) {
  if (pair === "BTCUSD") {
    return {
      type: "crypto",
      defaultRr: 2.1,
      atrMultiplier: 1.85,
      fallbackRiskPercent: 0.006
    };
  }

  if (pair === "XAUUSD") {
    return {
      type: "gold",
      defaultRr: 2.2,
      atrMultiplier: 1.55,
      fallbackRiskPercent: 0.003
    };
  }

  return {
    type: "forex",
    defaultRr: 2.0,
    atrMultiplier: pair.includes("JPY") ? 1.55 : 1.4,
    fallbackRiskPercent: 0.002
  };
}

function getDefaultRr(pair) {
  if (pair === "BTCUSD") return 2.1;
  if (pair === "XAUUSD") return 2.2;

  return 2;
}

function getMaxBarsHold(timeframe, pair) {
  const p = String(pair || "").toUpperCase();

  if (p === "BTCUSD") {
    if (timeframe === "M5") return 18;
    if (timeframe === "M15") return 14;
    if (timeframe === "H1") return 10;
    if (timeframe === "H4") return 8;
  }

  if (timeframe === "M5") return 18;
  if (timeframe === "M15") return 12;
  if (timeframe === "H1") return 10;
  if (timeframe === "H4") return 8;

  return 12;
}

function getSampleQuality(count, type) {
  if (type === "crypto") {
    if (count >= 25) return "high";
    if (count >= 12) return "medium";
    if (count >= 5) return "low";

    return "very-low";
  }

  if (count >= 35) return "high";
  if (count >= 18) return "medium";
  if (count >= 8) return "low";

  return "very-low";
}

function getConfidenceBand(score, metrics) {
  if (metrics.trades >= 30 && score >= 78) return "very-high";
  if (metrics.trades >= 18 && score >= 70) return "high";
  if (metrics.trades >= 8 && score >= 60) return "medium";
  if (score >= 50) return "low";

  return "very-low";
}

function getFallbackConfidenceBand(score) {
  if (score >= 76) return "medium";
  if (score >= 64) return "low";

  return "very-low";
}

function getModelBias(scan, score) {
  if (scan.signal === "WAIT") return "neutral";
  if (score >= 72 && scan.signal === "BUY") return "bullish";
  if (score >= 72 && scan.signal === "SELL") return "bearish";
  if (score < 55) return "avoid";

  return "neutral";
}

function buildNotes(scan, score, metrics, hasBacktest) {
  const notes = [];

  notes.push(`VectorBT score ${Math.round(score)}/100`);

  if (hasBacktest) {
    notes.push(`Local backtest trades: ${metrics?.trades || 0}`);
    notes.push(`Expectancy: ${Number(metrics?.expectancy || 0).toFixed(3)}R`);
  } else {
    notes.push("Fallback scoring without candles");
  }

  if (scan.pair === "BTCUSD") {
    notes.push("BTC volatility-adjusted backtest model");
  }

  if (scan.pair === "XAUUSD") {
    notes.push("Gold backtest model");
  }

  if (scan.signal === "WAIT") {
    notes.push("No directional signal");
  }

  return notes;
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

function normalizeTimeframe(value) {
  const timeframe = String(value || "")
    .toUpperCase()
    .trim();

  return ["M5", "M15", "H1", "H4"].includes(timeframe) ? timeframe : "";
}

function roundByPair(value, pair) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  const p = String(pair || "").toUpperCase();

  if (p === "XAUUSD" || p === "BTCUSD") return Number(n.toFixed(2));
  if (p.includes("JPY")) return Number(n.toFixed(3));

  return Number(n.toFixed(5));
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

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
                                 }
