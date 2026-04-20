export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const pair = cleanPair(url.searchParams.get("pair"));
    const timeframe = normalizeTimeframe(url.searchParams.get("timeframe"));
    const env = context.env || {};
    const apiKey = env.ALPHAVANTAGE_API_KEY || "";

    if (!pair) {
      return json(
        {
          ok: false,
          error: "Missing pair"
        },
        400
      );
    }

    const meta = parsePair(pair);
    if (!meta) {
      return json(buildFallbackPayload(pair, timeframe, "unsupported-pair"));
    }

    let payload;

    if (meta.type === "forex" && apiKey) {
      payload = await fetchAlphaVantageForex(meta, timeframe, apiKey);
    } else if (meta.type === "forex") {
      payload = buildFallbackPayload(pair, timeframe, "missing-alpha-key");
    } else {
      payload = buildFallbackPayload(pair, timeframe, "non-forex-fallback");
    }

    return json(payload);
  } catch {
    return json(
      {
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
          momentum: 0
        }
      },
      200
    );
  }
}

async function fetchAlphaVantageForex(meta, timeframe, apiKey) {
  const interval = mapTimeframeToAlphaInterval(timeframe);
  const endpoint =
    `https://www.alphavantage.co/query?function=FX_INTRADAY` +
    `&from_symbol=${encodeURIComponent(meta.base)}` +
    `&to_symbol=${encodeURIComponent(meta.quote)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=compact` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    return buildFallbackPayload(meta.pair, timeframe, "alpha-http-fallback");
  }

  const data = await res.json();

  if (data["Error Message"] || data["Information"] || data["Note"]) {
    return buildFallbackPayload(meta.pair, timeframe, "alpha-rate-limit-fallback");
  }

  const seriesKey = Object.keys(data).find((key) => key.toLowerCase().includes("time series"));
  const series = seriesKey ? data[seriesKey] : null;

  if (!series || typeof series !== "object") {
    return buildFallbackPayload(meta.pair, timeframe, "alpha-empty-series");
  }

  const candles = Object.entries(series)
    .map(([timestamp, value]) => {
      const open = Number(value["1. open"]);
      const high = Number(value["2. high"]);
      const low = Number(value["3. low"]);
      const close = Number(value["4. close"]);

      return {
        time: Math.floor(new Date(timestamp + "Z").getTime() / 1000),
        open: roundPrice(open, meta.pair),
        high: roundPrice(high, meta.pair),
        low: roundPrice(low, meta.pair),
        close: roundPrice(close, meta.pair)
      };
    })
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time)
    .slice(-160);

  if (!candles.length) {
    return buildFallbackPayload(meta.pair, timeframe, "alpha-no-candles");
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  return {
    ok: true,
    source: "alphavantage-fx-intraday",
    pair: meta.pair,
    timeframe,
    price: candles.at(-1)?.close ?? null,
    candles,
    indicators: {
      atr14: safeNum(atr(highs, lows, closes, 14)),
      rsi14: safeNum(rsi(closes, 14)),
      ema20: safeNum(ema(closes, 20)),
      ema50: safeNum(ema(closes, 50)),
      momentum: safeNum(computeMomentum(closes, 12))
    }
  };
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
      momentum: safeNum(computeMomentum(closes, 12))
    }
  };
}

function parsePair(pair) {
  const special = {
    XAUUSD: { pair: "XAUUSD", type: "special", base: "XAU", quote: "USD" },
    NAS100: { pair: "NAS100", type: "special", base: "NAS", quote: "USD" },
    GER40: { pair: "GER40", type: "special", base: "GER", quote: "EUR" }
  };

  if (special[pair]) return special[pair];

  if (/^[A-Z]{6}$/.test(pair)) {
    return {
      pair,
      type: "forex",
      base: pair.slice(0, 3),
      quote: pair.slice(3, 6)
    };
  }

  return null;
}

function normalizeTimeframe(value) {
  const allowed = ["M5", "M15", "H1", "H4"];
  return allowed.includes(String(value || "").toUpperCase())
    ? String(value).toUpperCase()
    : "M15";
}

function mapTimeframeToAlphaInterval(timeframe) {
  if (timeframe === "M5") return "5min";
  if (timeframe === "M15") return "15min";
  if (timeframe === "H1") return "60min";
  return "60min";
}

function cleanPair(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
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
    EURJPY: 163.4,
    GBPJPY: 192.3,
    AUDUSD: 0.661,
    NZDUSD: 0.607,
    USDCAD: 1.352,
    USDCHF: 0.903,
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
  if (symbol === "XAUUSD") return Number(value.toFixed(2));
  if (symbol === "NAS100" || symbol === "GER40") return Number(value.toFixed(1));
  if (symbol.includes("JPY")) return Number(value.toFixed(3));
  return Number(value.toFixed(5));
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
