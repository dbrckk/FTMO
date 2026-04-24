export async function onRequestGet(context) {
  return handleRequest(context);
}

export async function onRequestPost(context) {
  return handleRequest(context);
}

async function handleRequest(context) {
  try {
    const url = new URL(context.request.url);

    let pair = cleanPair(url.searchParams.get("pair"));
    let timeframe = normalizeTimeframe(url.searchParams.get("timeframe"));

    if (context.request.method.toUpperCase() === "POST") {
      try {
        const body = await context.request.clone().json();
        pair = cleanPair(body?.pair || body?.data?.pair || pair);
        timeframe = normalizeTimeframe(body?.timeframe || body?.data?.timeframe || timeframe);
      } catch {}
    }

    if (!pair) {
      return json({ ok: false, error: "Missing pair" }, 400);
    }

    const env = context.env || {};
    const apiKey = env.TWELVEDATA_API_KEY || "";
    const db = env.DB || null;

    const symbolMeta = mapSymbolForProvider(pair);
    if (!symbolMeta) {
      return json(buildSyntheticFallback(pair, timeframe, "unsupported-symbol"));
    }

    if (apiKey) {
      const livePayload = await tryTwelveDataLive(symbolMeta, timeframe, apiKey);
      if (livePayload?.ok && Array.isArray(livePayload.candles) && livePayload.candles.length) {
        return json(livePayload);
      }
    }

    if (db) {
      const d1Payload = await tryD1History(db, pair, timeframe);
      if (d1Payload?.ok && Array.isArray(d1Payload.candles) && d1Payload.candles.length) {
        return json(d1Payload);
      }
    }

    return json(buildSyntheticFallback(pair, timeframe, "synthetic-fallback"));
  } catch (error) {
    return json({
      ok: true,
      source: "server-catch-fallback",
      error: String(error?.message || error || "unknown"),
      pair: "",
      timeframe: "M15",
      price: null,
      candles: [],
      indicators: {
        atr14: 0,
        rsi14: 50,
        ema20: 0,
        ema50: 0,
        macd: 0,
        momentum: 0
      }
    });
  }
}

async function tryTwelveDataLive(symbolMeta, timeframe, apiKey) {
  try {
    const interval = mapTimeframeToProvider(timeframe);

    const candleUrl =
      `https://api.twelvedata.com/time_series` +
      `?symbol=${encodeURIComponent(symbolMeta.providerSymbol)}` +
      `&interval=${encodeURIComponent(interval)}` +
      `&outputsize=220` +
      `&apikey=${encodeURIComponent(apiKey)}`;

    const candleRes = await fetch(candleUrl, {
      method: "GET",
      headers: { Accept: "application/json" }
    });

    if (!candleRes.ok) return null;

    const candleData = await candleRes.json();
    if (!Array.isArray(candleData.values)) return null;

    const candles = candleData.values
      .map((row) => ({
        time: toUnixSeconds(row.datetime),
        open: roundPrice(Number(row.open), symbolMeta.localPair),
        high: roundPrice(Number(row.high), symbolMeta.localPair),
        low: roundPrice(Number(row.low), symbolMeta.localPair),
        close: roundPrice(Number(row.close), symbolMeta.localPair)
      }))
      .filter((c) =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.time > 0
      )
      .sort((a, b) => a.time - b.time)
      .slice(-220);

    if (!candles.length) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    return {
      ok: true,
      source: "twelvedata-live",
      pair: symbolMeta.localPair,
      timeframe,
      price: candles.at(-1)?.close ?? null,
      candles,
      indicators: {
        atr14: safeNum(atr(highs, lows, closes, 14)),
        rsi14: safeNum(rsi(closes, 14)),
        ema20: safeNum(ema(closes, 20)),
        ema50: safeNum(ema(closes, 50)),
        macd: safeNum(computeMacdLine(closes)),
        momentum: safeNum(computeMomentum(closes, 12))
      }
    };
  } catch {
    return null;
  }
}

async function tryD1History(db, pair, timeframe) {
  try {
    const result = await db
      .prepare(`
        SELECT pair, timeframe, ts, open, high, low, close, source
        FROM market_candles
        WHERE pair = ? AND timeframe = ?
        ORDER BY ts DESC
        LIMIT 220
      `)
      .bind(pair, timeframe)
      .all();

    const rows = Array.isArray(result?.results) ? result.results : [];
    if (!rows.length) return null;

    const candles = rows
      .map((row) => ({
        time: Number(row.ts || 0),
        open: Number(row.open || 0),
        high: Number(row.high || 0),
        low: Number(row.low || 0),
        close: Number(row.close || 0)
      }))
      .filter((c) =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.time > 0
      )
      .sort((a, b) => a.time - b.time);

    if (!candles.length) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    return {
      ok: true,
      source: "d1-history-fallback",
      pair,
      timeframe,
      price: candles.at(-1)?.close ?? null,
      candles,
      indicators: {
        atr14: safeNum(atr(highs, lows, closes, 14)),
        rsi14: safeNum(rsi(closes, 14)),
        ema20: safeNum(ema(closes, 20)),
        ema50: safeNum(ema(closes, 50)),
        macd: safeNum(computeMacdLine(closes)),
        momentum: safeNum(computeMomentum(closes, 12))
      }
    };
  } catch {
    return null;
  }
}

function mapSymbolForProvider(pair) {
  const map = {
    EURUSD: "EUR/USD",
    GBPUSD: "GBP/USD",
    USDJPY: "USD/JPY",
    USDCHF: "USD/CHF",
    USDCAD: "USD/CAD",
    AUDUSD: "AUD/USD",
    NZDUSD: "NZD/USD",

    EURGBP: "EUR/GBP",
    EURJPY: "EUR/JPY",
    EURCHF: "EUR/CHF",
    EURCAD: "EUR/CAD",
    EURAUD: "EUR/AUD",
    EURNZD: "EUR/NZD",

    GBPJPY: "GBP/JPY",
    GBPCHF: "GBP/CHF",
    GBPCAD: "GBP/CAD",
    GBPAUD: "GBP/AUD",
    GBPNZD: "GBP/NZD",

    AUDJPY: "AUD/JPY",
    AUDCAD: "AUD/CAD",
    AUDCHF: "AUD/CHF",
    AUDNZD: "AUD/NZD",

    NZDJPY: "NZD/JPY",
    NZDCAD: "NZD/CAD",

    XAUUSD: "XAU/USD"
  };

  const providerSymbol = map[pair];
  if (!providerSymbol) return null;

  return {
    localPair: pair,
    providerSymbol
  };
}

function normalizeTimeframe(value) {
  const tf = String(value || "").toUpperCase().trim();
  if (["M5", "M15", "H1", "H4"].includes(tf)) return tf;
  return "M15";
}

function mapTimeframeToProvider(tf) {
  if (tf === "M5") return "5min";
  if (tf === "M15") return "15min";
  if (tf === "H1") return "1h";
  return "4h";
}

function buildSyntheticFallback(pair, timeframe, source) {
  const candles = generateSyntheticCandles(pair, timeframe);
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  return {
    ok: true,
    source,
    pair,
    timeframe,
    price: candles.at(-1)?.close ?? null,
    candles,
    indicators: {
      atr14: safeNum(atr(highs, lows, closes, 14)),
      rsi14: safeNum(rsi(closes, 14)),
      ema20: safeNum(ema(closes, 20)),
      ema50: safeNum(ema(closes, 50)),
      macd: safeNum(computeMacdLine(closes)),
      momentum: safeNum(computeMomentum(closes, 12))
    }
  };
}

function generateSyntheticCandles(pair, timeframe) {
  const base = getSymbolBasePrice(pair);
  const stepMap = { M5: 0.0008, M15: 0.0014, H1: 0.0038, H4: 0.009 };
  const rawStep = stepMap[timeframe] || 0.0014;

  const step =
    pair === "XAUUSD" ? 4.5 :
    pair.includes("JPY") ? rawStep * 100 :
    rawStep;

  const candles = [];
  let price = base;
  let time = Math.floor(Date.now() / 1000) - 220 * timeframeToSeconds(timeframe);

  for (let i = 0; i < 220; i += 1) {
    const wave = Math.sin(i / 7) * step * 1.2;
    const drift = (hashCode(pair) % 2 === 0 ? 1 : -1) * step * 0.08;
    const noise = (Math.random() - 0.5) * step * 1.6;

    const open = price;
    const close = open + wave + drift + noise;
    const high = Math.max(open, close) + Math.abs(noise) * 1.1 + step * 0.35;
    const low = Math.min(open, close) - Math.abs(noise) * 1.1 - step * 0.35;

    candles.push({
      time,
      open: roundPrice(open, pair),
      high: roundPrice(high, pair),
      low: roundPrice(low, pair),
      close: roundPrice(close, pair)
    });

    price = close;
    time += timeframeToSeconds(timeframe);
  }

  return candles;
}

function getSymbolBasePrice(symbol) {
  const prices = {
    EURUSD: 1.0835,
    GBPUSD: 1.2710,
    USDJPY: 151.15,
    USDCHF: 0.9030,
    USDCAD: 1.3520,
    AUDUSD: 0.6610,
    NZDUSD: 0.6070,

    EURGBP: 0.8510,
    EURJPY: 163.40,
    EURCHF: 0.9780,
    EURCAD: 1.4650,
    EURAUD: 1.6390,
    EURNZD: 1.7750,

    GBPJPY: 192.30,
    GBPCHF: 1.1490,
    GBPCAD: 1.7190,
    GBPAUD: 1.9240,
    GBPNZD: 2.0830,

    AUDJPY: 99.10,
    AUDCAD: 0.8940,
    AUDCHF: 0.5970,
    AUDNZD: 1.0820,

    NZDJPY: 91.70,
    NZDCAD: 0.8220,

    XAUUSD: 2350.50
  };

  return prices[symbol] || 1;
}

function timeframeToSeconds(tf) {
  if (tf === "M5") return 300;
  if (tf === "M15") return 900;
  if (tf === "H1") return 3600;
  return 14400;
}

function computeMomentum(closes, lookback = 12) {
  if (closes.length <= lookback) return 0;
  const current = closes.at(-1);
  const past = closes.at(-1 - lookback);
  if (!past) return 0;
  return ((current - past) / past) * 100;
}

function ema(values, period) {
  return emaSeries(values, period).at(-1) ?? 0;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0] ?? 0;

  for (let i = 0; i < values.length; i += 1) {
    prev = i === 0 ? (values[0] ?? 0) : values[i] * k + prev * (1 - k);
    out.push(prev);
  }

  return out;
}

function computeMacdLine(closes) {
  return ema(closes, 12) - ema(closes, 26);
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function atr(highs, lows, closes, period = 14) {
  if (highs.length < 2) return 0;

  const trs = [];
  for (let i = 1; i < highs.length; i += 1) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }

  const recent = trs.slice(-period);
  if (!recent.length) return 0;
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function toUnixSeconds(datetimeValue) {
  const direct = new Date(datetimeValue).getTime();
  if (Number.isFinite(direct) && direct > 0) {
    return Math.floor(direct / 1000);
  }

  const fallback = new Date(`${datetimeValue}Z`).getTime();
  if (Number.isFinite(fallback) && fallback > 0) {
    return Math.floor(fallback / 1000);
  }

  return 0;
}

function roundPrice(value, symbol) {
  if (!Number.isFinite(value)) return 0;
  if (symbol === "XAUUSD") return Number(value.toFixed(2));
  if (symbol.includes("JPY")) return Number(value.toFixed(3));
  return Number(value.toFixed(5));
}

function cleanPair(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function safeNum(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
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
