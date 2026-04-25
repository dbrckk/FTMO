const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

const TIMEFRAMES = ["M15", "H1", "H4"];
const CANDLE_LIMIT = 200;

const TIMEFRAME_WEIGHT = {
  M5: 0.22,
  M15: 0.30,
  H1: 0.35,
  H4: 0.35
};

const MAX_CANDLE_AGE_SECONDS = {
  M5: 60 * 60,
  M15: 3 * 60 * 60,
  H1: 8 * 60 * 60,
  H4: 24 * 60 * 60
};

export async function onRequestGet(context) {
  try {
    const db = context.env?.DB;

    if (!db) {
      return json({ ok: false, error: "Missing DB binding" }, 500);
    }

    const url = new URL(context.request.url);
    const includeM5 = String(url.searchParams.get("includeM5") || "0") === "1";
    const timeframes = includeM5 ? ["M5", ...TIMEFRAMES] : TIMEFRAMES;

    const summary = {};
    const scansByTimeframe = {};

    for (const timeframe of timeframes) {
      const scans = await scanTimeframe(db, timeframe);
      scansByTimeframe[timeframe] = scans;

      const allowed = scans
        .filter((scan) => scan.allowed)
        .sort((a, b) => Number(b.ultraScore || 0) - Number(a.ultraScore || 0));

      const blocked = scans
        .filter((scan) => !scan.allowed)
        .sort((a, b) => Number(b.ultraScore || 0) - Number(a.ultraScore || 0));

      summary[timeframe] = {
        timeframe,
        totalPairs: scans.length,
        freshPairs: scans.filter((s) => s.fresh).length,
        stalePairs: scans.filter((s) => !s.fresh && s.rowCount > 0).length,
        missingPairs: scans.filter((s) => s.rowCount === 0).length,
        allowedCount: allowed.length,
        blockedCount: blocked.length,
        best: allowed[0] || blocked[0] || null,
        topAllowed: allowed.slice(0, 5),
        topBlocked: blocked.slice(0, 5)
      };
    }

    const mtfAlignment = buildMtfAlignment(scansByTimeframe, timeframes);

    return json({
      ok: true,
      source: "timeframe-summary",
      version: "mtf-alignment-v2-btc",
      generatedAt: new Date().toISOString(),
      timeframes,
      mtfAlignment,
      summary
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "timeframe-summary-error")
    }, 500);
  }
}

async function scanTimeframe(db, timeframe) {
  const scans = [];

  for (const pair of PAIRS) {
    const candles = await getCandles(db, pair, timeframe);
    const freshness = getCandleFreshness(candles, timeframe);

    if (candles.length < 40) {
      scans.push({
        pair,
        timeframe,
        rowCount: candles.length,
        fresh: false,
        allowed: false,
        ultraScore: 0,
        status: "SKIPPED",
        signal: "WAIT",
        direction: "wait",
        reason: candles.length ? "Not enough candles" : "Missing candles",
        candleAgeMinutes: freshness.ageMinutes
      });
      continue;
    }

    if (!freshness.fresh) {
      scans.push({
        pair,
        timeframe,
        rowCount: candles.length,
        fresh: false,
        allowed: false,
        ultraScore: 0,
        status: "STALE",
        signal: "WAIT",
        direction: "wait",
        reason: `Stale market data: ${freshness.ageMinutes} min old`,
        candleAgeMinutes: freshness.ageMinutes
      });
      continue;
    }

    scans.push(buildScan(pair, timeframe, candles, freshness));
  }

  return scans;
}

async function getCandles(db, pair, timeframe) {
  const res = await db
    .prepare(`
      SELECT ts, open, high, low, close
      FROM market_candles
      WHERE pair = ? AND timeframe = ?
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

function buildScan(pair, timeframe, candles, freshness) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const current = closes.at(-1);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(highs, lows, closes, 14);
  const momentum = computeMomentum(closes, 12);
  const macd = ema(closes, 12) - ema(closes, 26);

  const trendScore = clamp(
    50 +
      (ema20 > ema50 ? 18 : -18) +
      (current > ema20 ? 8 : -8) +
      (momentum > 0 ? 8 : -8),
    1,
    99
  );

  const timingScore = clamp(
    50 +
      (rsi14 >= 43 && rsi14 <= 66 ? 14 : -8) +
      (macd > 0 ? 8 : -8),
    1,
    99
  );

  const riskScore = clamp(
    74 -
      (pair === "XAUUSD" ? 8 : 0) -
      (pair === "BTCUSD" ? 10 : 0) -
      (pair.startsWith("GBP") ? 2 : 0),
    1,
    99
  );

  const sessionScore = scoreSession(pair);

  const rr =
    pair === "XAUUSD" ? 2.2 :
    pair === "BTCUSD" ? 2.1 :
    2.0;

  const direction =
    trendScore >= 55 && timingScore >= 50
      ? "buy"
      : trendScore <= 45 && timingScore <= 50
        ? "sell"
        : "wait";

  const timeframeBoost =
    timeframe === "H4" ? 1.08 :
    timeframe === "H1" ? 1.04 :
    timeframe === "M15" ? 1 :
    0.96;

  const ultraScore = clamp(
    (
      trendScore * 0.32 +
      timingScore * 0.25 +
      riskScore * 0.16 +
      sessionScore * 0.12 +
      clamp(rr * 24, 1, 99) * 0.15
    ) * timeframeBoost,
    1,
    99
  );

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

  const allowed =
    direction !== "wait" &&
    ultraScore >= 72 &&
    riskScore >= 45;

  return {
    pair,
    timeframe,
    rowCount: candles.length,
    fresh: true,
    candleAgeMinutes: freshness.ageMinutes,
    current: roundByPair(current, pair),
    direction,
    signal: direction === "sell" ? "SELL" : direction === "buy" ? "BUY" : "WAIT",
    ultraScore: Math.round(ultraScore),
    trendScore: Math.round(trendScore),
    timingScore: Math.round(timingScore),
    riskScore: Math.round(riskScore),
    sessionScore: Math.round(sessionScore),
    rsi14: round(rsi14, 2),
    atr14: roundByPair(atr14, pair),
    rr,
    stopLoss: roundByPair(stopLoss, pair),
    takeProfit: roundByPair(takeProfit, pair),
    allowed,
    status: allowed
      ? pair === "BTCUSD"
        ? "VALID BTC"
        : pair === "XAUUSD"
          ? "VALID GOLD"
          : "VALID"
      : "BLOCKED",
    reason: allowed ? "Multi-timeframe setup valid" : "Not enough confluence"
  };
}

function buildMtfAlignment(scansByTimeframe, timeframes) {
  const results = [];

  for (const pair of PAIRS) {
    const pairScans = timeframes
      .map((timeframe) => scansByTimeframe[timeframe]?.find((scan) => scan.pair === pair))
      .filter(Boolean)
      .filter((scan) => scan.fresh);

    if (!pairScans.length) continue;

    const buy = computePairDirectionAlignment(pair, "BUY", pairScans);
    const sell = computePairDirectionAlignment(pair, "SELL", pairScans);

    const best = buy.score >= sell.score ? buy : sell;

    if (best.score > 0) {
      results.push(best);
    }
  }

  const topPairs = results
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.averageUltraScore - a.averageUltraScore;
    })
    .slice(0, 10);

  return {
    best: topPairs[0] || null,
    topPairs
  };
}

function computePairDirectionAlignment(pair, signal, pairScans) {
  const matching = pairScans.filter((scan) => scan.signal === signal);
  const opposite = pairScans.filter((scan) => scan.signal !== signal && scan.signal !== "WAIT");

  if (!matching.length) {
    return {
      pair,
      signal,
      direction: signal.toLowerCase(),
      score: 0,
      label: "No alignment",
      timeframes: [],
      averageUltraScore: 0,
      allowedCount: 0,
      oppositeCount: opposite.length
    };
  }

  let weightedScore = 0;
  let totalWeight = 0;

  for (const scan of matching) {
    const weight = TIMEFRAME_WEIGHT[scan.timeframe] || 0.3;
    weightedScore += Number(scan.ultraScore || 0) * weight;
    totalWeight += weight;
  }

  const averageUltraScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const agreementRatio = matching.length / Math.max(1, pairScans.length);
  const allowedCount = matching.filter((scan) => scan.allowed).length;
  const allowedRatio = allowedCount / Math.max(1, matching.length);

  const hasH1 = matching.some((scan) => scan.timeframe === "H1");
  const hasH4 = matching.some((scan) => scan.timeframe === "H4");
  const higherTfBoost = (hasH1 ? 7 : 0) + (hasH4 ? 10 : 0);
  const oppositePenalty = opposite.length * 12;

  const score = Math.round(
    clamp(
      averageUltraScore * 0.56 +
        agreementRatio * 24 +
        allowedRatio * 12 +
        higherTfBoost -
        oppositePenalty,
      0,
      100
    )
  );

  let label = "Weak alignment";

  if (score >= 82 && matching.length >= 2 && (hasH1 || hasH4)) {
    label = "Strong alignment";
  } else if (score >= 68 && matching.length >= 2) {
    label = "Medium alignment";
  } else if (score >= 52) {
    label = "Mixed alignment";
  }

  return {
    pair,
    signal,
    direction: signal.toLowerCase(),
    score,
    label,
    timeframes: matching.map((scan) => ({
      timeframe: scan.timeframe,
      ultraScore: scan.ultraScore,
      allowed: scan.allowed,
      current: scan.current,
      stopLoss: scan.stopLoss,
      takeProfit: scan.takeProfit,
      candleAgeMinutes: scan.candleAgeMinutes
    })),
    averageUltraScore: round(averageUltraScore, 2),
    allowedCount,
    oppositeCount: opposite.length,
    freshCount: pairScans.length
  };
}

function getCandleFreshness(candles, timeframe) {
  const last = candles.at(-1);
  const lastTs = Number(last?.time || 0);
  const now = Math.floor(Date.now() / 1000);

  if (!lastTs) {
    return {
      fresh: false,
      ageSeconds: 999999999,
      ageMinutes: 999999
    };
  }

  const ageSeconds = Math.max(0, now - lastTs);
  const maxAge = MAX_CANDLE_AGE_SECONDS[timeframe] || MAX_CANDLE_AGE_SECONDS.M15;

  return {
    fresh: ageSeconds <= maxAge,
    ageSeconds,
    ageMinutes: Math.round(ageSeconds / 60)
  };
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

function roundByPair(value, pair) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  if (pair === "XAUUSD") return Number(n.toFixed(2));
  if (pair === "BTCUSD") return Number(n.toFixed(2));
  if (String(pair).includes("JPY")) return Number(n.toFixed(3));

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
                }
