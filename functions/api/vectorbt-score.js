export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const data = body?.data || body || {};
    const candles = Array.isArray(data.candles) ? data.candles : [];

    if (candles.length < 30) {
      return json({
        ok: true,
        source: "vectorbt-local-fallback",
        vectorbtScore: 50,
        confidenceBand: "low",
        explanation: "Pas assez de bougies pour un backtest fiable.",
        metrics: emptyMetrics()
      });
    }

    const normalized = normalizeCandles(candles);
    const metrics = runLocalBacktest(normalized, data);
    const vectorbtScore = scoreBacktest(metrics);

    return json({
      ok: true,
      source: "local-vectorbt-like-engine",
      vectorbtScore,
      confidenceBand:
        metrics.totalTrades >= 20 && vectorbtScore >= 70 ? "high" :
        metrics.totalTrades >= 10 ? "medium" :
        "low",
      explanation: buildExplanation(metrics, vectorbtScore),
      metrics
    });
  } catch (error) {
    return json({
      ok: true,
      source: "vectorbt-safe-fallback",
      vectorbtScore: 55,
      confidenceBand: "medium",
      explanation: String(error?.message || "VectorBT fallback utilisé."),
      metrics: emptyMetrics()
    });
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    message: "POST candles to compute vectorbt-like score."
  });
}

function normalizeCandles(candles) {
  return candles
    .map((c) => ({
      time: Number(c.time || c.ts || 0),
      open: Number(c.open || 0),
      high: Number(c.high || 0),
      low: Number(c.low || 0),
      close: Number(c.close || 0)
    }))
    .filter((c) =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

function runLocalBacktest(candles, params) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const fastPeriod = Number(params.fast_ema || 20);
  const slowPeriod = Number(params.slow_ema || 50);
  const atrPeriod = Number(params.atr_period || 14);
  const stopAtrMult = Number(params.stop_atr_mult || 1.4);
  const takeAtrMult = Number(params.take_atr_mult || 2.6);

  const fast = emaSeries(closes, fastPeriod);
  const slow = emaSeries(closes, slowPeriod);
  const atrValues = atrSeries(highs, lows, closes, atrPeriod);

  const trades = [];

  let position = null;

  for (let i = slowPeriod + 2; i < candles.length; i += 1) {
    const price = candles[i].close;
    const atrValue = atrValues[i] || price * 0.002;

    const bullish =
      fast[i] > slow[i] &&
      fast[i - 1] <= slow[i - 1];

    const bearish =
      fast[i] < slow[i] &&
      fast[i - 1] >= slow[i - 1];

    if (!position) {
      if (bullish) {
        position = {
          direction: "buy",
          entry: price,
          stop: price - atrValue * stopAtrMult,
          target: price + atrValue * takeAtrMult,
          entryIndex: i
        };
      } else if (bearish) {
        position = {
          direction: "sell",
          entry: price,
          stop: price + atrValue * stopAtrMult,
          target: price - atrValue * takeAtrMult,
          entryIndex: i
        };
      }

      continue;
    }

    const candle = candles[i];
    const maxHoldBars = 16;

    let exit = null;
    let reason = "";

    if (position.direction === "buy") {
      if (candle.low <= position.stop) {
        exit = position.stop;
        reason = "stop";
      } else if (candle.high >= position.target) {
        exit = position.target;
        reason = "target";
      }
    } else {
      if (candle.high >= position.stop) {
        exit = position.stop;
        reason = "stop";
      } else if (candle.low <= position.target) {
        exit = position.target;
        reason = "target";
      }
    }

    if (!exit && i - position.entryIndex >= maxHoldBars) {
      exit = price;
      reason = "time";
    }

    if (exit) {
      const risk = Math.abs(position.entry - position.stop);
      let pnlR = 0;

      if (risk > 0) {
        pnlR =
          position.direction === "buy"
            ? (exit - position.entry) / risk
            : (position.entry - exit) / risk;
      }

      trades.push({
        direction: position.direction,
        entry: position.entry,
        exit,
        pnlR,
        reason
      });

      position = null;
    }
  }

  return buildMetrics(trades);
}

function buildMetrics(trades) {
  if (!trades.length) return emptyMetrics();

  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnlR > 0).length;
  const losses = totalTrades - wins;
  const winRatePct = (wins / totalTrades) * 100;

  const grossWin = trades
    .filter((t) => t.pnlR > 0)
    .reduce((sum, t) => sum + t.pnlR, 0);

  const grossLossAbs = Math.abs(
    trades
      .filter((t) => t.pnlR <= 0)
      .reduce((sum, t) => sum + t.pnlR, 0)
  );

  const expectancy =
    trades.reduce((sum, t) => sum + t.pnlR, 0) / totalTrades;

  const profitFactor = grossLossAbs > 0 ? grossWin / grossLossAbs : grossWin > 0 ? 3 : 0;

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const trade of trades) {
    equity += trade.pnlR;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }

  const returns = trades.map((t) => t.pnlR);
  const avg = expectancy;
  const std = standardDeviation(returns);
  const sharpeRatio = std > 0 ? avg / std : 0;

  return {
    totalReturnPct: Number((expectancy * totalTrades * 2).toFixed(2)),
    winRatePct: Number(winRatePct.toFixed(2)),
    maxDrawdownPct: Number((Math.abs(maxDrawdown) * 2).toFixed(2)),
    totalTrades,
    wins,
    losses,
    profitFactor: Number(profitFactor.toFixed(2)),
    sharpeRatio: Number(sharpeRatio.toFixed(3)),
    expectancy: Number(expectancy.toFixed(4))
  };
}

function scoreBacktest(metrics) {
  if (!metrics.totalTrades) return 50;

  const winScore = clamp(50 + (metrics.winRatePct - 50) * 1.1, 1, 99);
  const pfScore = clamp(metrics.profitFactor * 28, 1, 99);
  const expScore = clamp(50 + metrics.expectancy * 28, 1, 99);
  const ddScore = clamp(80 - metrics.maxDrawdownPct * 2.5, 1, 99);
  const sampleScore = clamp(metrics.totalTrades * 3, 1, 99);

  return Math.round(
    winScore * 0.24 +
      pfScore * 0.24 +
      expScore * 0.24 +
      ddScore * 0.16 +
      sampleScore * 0.12
  );
}

function buildExplanation(metrics, score) {
  if (!metrics.totalTrades) {
    return "Backtest local neutre : aucun trade détecté sur la fenêtre.";
  }

  if (score >= 75) {
    return `Backtest favorable : WR ${metrics.winRatePct}%, PF ${metrics.profitFactor}, expectancy ${metrics.expectancy}R.`;
  }

  if (score >= 58) {
    return `Backtest moyen : WR ${metrics.winRatePct}%, PF ${metrics.profitFactor}, ${metrics.totalTrades} trades.`;
  }

  return `Backtest faible : expectancy ${metrics.expectancy}R, drawdown ${metrics.maxDrawdownPct}%.`;
}

function emptyMetrics() {
  return {
    totalReturnPct: 0,
    winRatePct: 0,
    maxDrawdownPct: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    profitFactor: 0,
    sharpeRatio: 0,
    expectancy: 0
  };
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0] || 0;

  for (let i = 0; i < values.length; i += 1) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }

  return out;
}

function atrSeries(highs, lows, closes, period = 14) {
  const out = [];

  for (let i = 0; i < highs.length; i += 1) {
    if (i === 0) {
      out.push(0);
      continue;
    }

    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );

    const start = Math.max(1, i - period + 1);
    const values = [];

    for (let j = start; j <= i; j += 1) {
      const value = Math.max(
        highs[j] - lows[j],
        Math.abs(highs[j] - closes[j - 1]),
        Math.abs(lows[j] - closes[j - 1])
      );
      values.push(value);
    }

    out.push(values.reduce((sum, v) => sum + v, 0) / values.length);
  }

  return out;
}

function standardDeviation(values) {
  if (!values.length) return 0;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
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
