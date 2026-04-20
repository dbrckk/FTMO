export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const pair = cleanPair(url.searchParams.get("pair"));
    const timeframe = normalizeTimeframe(url.searchParams.get("timeframe"));
    const env = context.env || {};
    const apiKey = env.TWELVEDATA_API_KEY || "";

    if (!pair) {
      return json({ ok: false, error: "Missing pair" }, 400);
    }

    const symbolMeta = mapSymbolForProvider(pair);
    if (!symbolMeta) {
      return json(buildFallbackPayload(pair, timeframe, "unsupported-symbol"));
    }

    let payload;
    if (apiKey) {
      payload = await fetchTwelveDataBundle(symbolMeta, timeframe, apiKey);
    } else {
      payload = buildFallbackPayload(pair, timeframe, "missing-twelvedata-key");
    }

    return json(payload);
  } catch {
    return json({
      ok: true,
      source: "server-catch-fallback",
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

async function fetchTwelveDataBundle(symbolMeta, timeframe, apiKey) {
  try {
    const interval = mapTimeframeToProvider(timeframe);
    const candleUrl =
      `https://api.twelvedata.com/time_series` +
      `?symbol=${encodeURIComponent(symbolMeta.providerSymbol)}` +
      `&interval=${encodeURIComponent(interval)}` +
      `&outputsize=200` +
      `&apikey=${encodeURIComponent(apiKey)}`;

    const candleRes = await fetch(candleUrl, {
      method: "GET",
      headers: { Accept: "application/json" }
    });

    if (!candleRes.ok) {
      return buildFallbackPayload(symbolMeta.localPair, timeframe, "twelvedata-http-error");
    }

    const candleData = await candleRes.json();

    if (!Array.isArray(candleData.values)) {
      return buildFallbackPayload(symbolMeta.localPair, timeframe, "twelvedata-invalid-series");
    }

    const candles = candleData.values
      .map((row) => ({
        time: Math.floor(new Date(`${row.datetime}Z`).getTime() / 1000),
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
        Number.isFinite(c.close)
      )
      .sort((a, b) => a.time - b.time)
      .slice(-160);

    if (!candles.length) {
      return buildFallbackPayload(symbolMeta.localPair, timeframe, "twelvedata-empty-candles");
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const indicators = await fetchTwelveIndicators(
      symbolMeta.providerSymbol,
      interval,
      apiKey,
      symbolMeta.localPair
    );

    return {
      ok: true,
      source: "twelvedata-live",
      pair: symbolMeta.localPair,
      timeframe,
      price: candles.at(-1)?.close ?? null,
      candles,
      indicators: {
        atr14: safeNum(indicators.atr14 ?? atr(highs, lows, closes, 14)),
        rsi14: safeNum(indicators.rsi14 ?? rsi(closes, 14)),
        ema20: safeNum(indicators.ema20 ?? ema(closes, 20)),
        ema50: safeNum(indicators.ema50 ?? ema(closes, 50)),
        macd: safeNum(indicators.macd ?? computeMacdLine(closes)),
        momentum: safeNum(indicators.momentum ?? computeMomentum(closes, 12))
      }
    };
  } catch {
    return buildFallbackPayload(symbolMeta.localPair, timeframe, "twelvedata-catch");
  }
}

async function fetchTwelveIndicators(symbol, interval, apiKey, localPair) {
  const endpoints = [
    {
      key: "rsi14",
      url:
        `https://api.twelvedata.com/rsi?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${encodeURIComponent(interval)}` +
        `&time_period=14&outputsize=1&apikey=${encodeURIComponent(apiKey)}`
    },
    {
      key: "ema20",
      url:
        `https://api.twelvedata.com/ema?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${encodeURIComponent(interval)}` +
        `&time_period=20&outputsize=1&apikey=${encodeURIComponent(apiKey)}`
    },
    {
      key: "ema50",
      url:
        `https://api.twelvedata.com/ema?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${encodeURIComponent(interval)}` +
        `&time_period=50&outputsize=1&apikey=${encodeURIComponent(apiKey)}`
    },
    {
      key: "atr14",
      url:
        `https://api.twelvedata.com/atr?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${encodeURIComponent(interval)}` +
        `&time_period=14&outputsize=1&apikey=${encodeURIComponent(apiKey)}`
    },
    {
      key: "macd",
      url:
        `https://api.twelvedata.com/macd?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${encodeURIComponent(interval)}` +
        `&fast_period=12&slow_period=26&signal_period=9&outputsize=1&apikey=${encodeURIComponent(apiKey)}`
    }
  ];

  const results = await Promise.all(
    endpoints.map(async (item) => {
      try {
        const res = await fetch(item.url, {
          method: "GET",
          headers: { Accept: "application/json" }
        });
        if (!res.ok) return [item.key, null];
        const data = await res.json();
        const first = Array.isArray(data.values) ? data.values[0] : null;
        if (!first) return [item.key, null];

        if (item.key === "macd") {
          return [item.key, roundPrice(Number(first.macd), localPair)];
        }

        const value = first[item.key.replace(/[0-9]/g, "")] ?? first.value;
        return [item.key, roundPrice(Number(value), localPair)];
      } catch {
        return [item.key, null];
      }
    })
  );

  return Object.fromEntries(results);
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
    GBPJPY: "GBP/JPY",
    AUDJPY: "AUD/JPY",
    CADJPY: "CAD/JPY",
    CHFJPY: "CHF/JPY",
    EURAUD: "EUR/AUD",
    EURNZD: "EUR/NZD",
    EURCAD: "EUR/CAD",
    EURCHF: "EUR/CHF",
    GBPAUD: "GBP/AUD",
    GBPNZD: "GBP/NZD",
    GBPCAD: "GBP/CAD",
    GBPCHF: "GBP/CHF",
    AUDNZD: "AUD/NZD",
    AUDCAD: "AUD/CAD",
    AUDCHF: "AUD/CHF",
    NZDCAD: "NZD/CAD",
    NZDCHF: "NZD/CHF",
    NZDJPY: "NZD/JPY",
    XAUUSD: "XAU/USD",
    NAS100: "NDX",
    GER40: "DAX"
  };

  const providerSymbol = map[pair];
  if (!providerSymbol) return null;

  return {
    localPair: pair,
    providerSymbol
  };
}

function normalizeTimeframe(value) {
  const allowed = ["M5", "M15", "H1", "H4"];
  const tf = String(value || "").toUpperCase();
  return allowed.includes(tf) ? tf : "M15";
}

function mapTimeframeToProvider(tf) {
  if (tf === "M5") return "5min";
  if (tf === "M15") return "15min";
  if (tf === "H1") return "1h";
  return "4h";
}

function buildFallbackPayload(pair, timeframe, source) {
  const candles = generateFallbackCandles(pair, timeframe);
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

function generateFallbackCandles(pair, timeframe) {
  const base = getSymbolBasePrice(pair);
  const stepMap = { M5: 0.0008, M15: 0.0014, H1: 0.0038, H4: 0.009 };
  const rawStep = stepMap[timeframe] || 0.0014;
  const step =
    pair === "XAUUSD" ? 4.8 :
    pair === "NAS100" ? 28 :
    pair === "GER40" ? 18 :
    pair.includes("JPY") ? rawStep * 100 :
    rawStep;

  const candles = [];
  let price = base;
  let time = Math.floor(Date.now() / 1000) - 160 * timeframeToSeconds(timeframe);

  for (let i = 0; i < 160; i += 1) {
    const wave = Math.sin(i / 7) * step * 1.2;
    const drift = (hashCode(pair) % 2 === 0 ? 1 : -1) * step * 0.08;
    const noise = (Math.random() - 0.5) * step * 1.7;

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
    GBPUSD: 1.271,
    USDJPY: 151.15,
    USDCHF: 0.903,
    USDCAD: 1.352,
    AUDUSD: 0.661,
    NZDUSD: 0.607,
    EURGBP: 0.851,
    EURJPY: 163.4,
    GBPJPY: 192.3,
    AUDJPY: 99.1,
    CADJPY: 111.4,
    CHFJPY: 167.3,
    EURAUD: 1.639,
    EURNZD: 1.775,
    EURCAD: 1.465,
    EURCHF: 0.978,
    GBPAUD: 1.924,
    GBPNZD: 2.083,
    GBPCAD: 1.719,
    GBPCHF: 1.149,
    AUDNZD: 1.082,
    AUDCAD: 0.894,
    AUDCHF: 0.597,
    NZDCAD: 0.822,
    NZDCHF: 0.552,
    NZDJPY: 91.7,
    XAUUSD: 2350.5,
    NAS100: 18240,
    GER40: 18420
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

function roundPrice(value, symbol) {
  if (!Number.isFinite(value)) return 0;
  if (symbol === "XAUUSD") return Number(value.toFixed(2));
  if (symbol === "NAS100" || symbol === "GER40") return Number(value.toFixed(1));
  if (symbol.includes("JPY")) return Number(value.toFixed(3));
  return Number(value.toFixed(5));
}

function cleanPair(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
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
