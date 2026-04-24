const CORE_PAIRS = [
  "XAUUSD",
  "EURUSD",
  "GBPUSD",
  "USDJPY"
];

const ROTATION_GROUPS = [
  ["USDCHF", "USDCAD"],
  ["AUDUSD", "NZDUSD"],
  ["EURGBP", "EURJPY"],
  ["EURCHF", "EURCAD"],
  ["EURAUD", "EURNZD"],
  ["GBPJPY", "GBPCHF"],
  ["GBPCAD", "GBPAUD"],
  ["GBPNZD", "AUDJPY"],
  ["AUDCAD", "AUDCHF"],
  ["AUDNZD", "NZDJPY"],
  ["NZDCAD"]
];

const DEFAULT_TIMEFRAMES = ["M15"];
const OUTPUT_SIZE = 200;
const WRITE_CHUNK = 100;

export async function onRequestGet(context) {
  return handleSync(context);
}

export async function onRequestPost(context) {
  return handleSync(context);
}

async function handleSync(context) {
  try {
    const env = context.env || {};
    const db = env.DB;
    const apiKey = env.TWELVEDATA_API_KEY || "";
    const syncSecret = env.SYNC_SECRET || "";

    if (!db) {
      return json({ ok: false, error: "Missing DB binding" }, 500);
    }

    if (!apiKey) {
      return json({ ok: false, error: "Missing TWELVEDATA_API_KEY" }, 500);
    }

    if (!isAuthorized(context.request, syncSecret)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    const url = new URL(context.request.url);

    const requestedPair = cleanPair(url.searchParams.get("pair"));
    const requestedTimeframe = normalizeTimeframe(url.searchParams.get("timeframe"));
    const requestedGroup = normalizeGroup(url.searchParams.get("group"));
    const includeCore = String(url.searchParams.get("includeCore") || "1") !== "0";

    const timeframes = requestedTimeframe ? [requestedTimeframe] : DEFAULT_TIMEFRAMES;

    let pairs = [];

    if (requestedPair) {
      pairs = [requestedPair];
    } else {
      const groupPairs = requestedGroup ? getPairsForGroup(requestedGroup) : getPairsForGroup(1);
      pairs = includeCore
        ? dedupeStrings([...CORE_PAIRS, ...groupPairs])
        : groupPairs;
    }

    const results = [];

    for (const pair of pairs) {
      for (const timeframe of timeframes) {
        try {
          const inserted = await syncOnePair(db, apiKey, pair, timeframe);
          results.push({
            pair,
            timeframe,
            ok: true,
            inserted
          });
        } catch (error) {
          results.push({
            pair,
            timeframe,
            ok: false,
            error: String(error?.message || error || "sync-error")
          });
        }
      }
    }

    const success = results.filter((r) => r.ok).length;
    const failed = results.length - success;
    const insertedTotal = results.reduce((sum, r) => sum + Number(r.inserted || 0), 0);

    return json({
      ok: true,
      mode: requestedPair ? "single-pair" : "rotation-group",
      group: requestedPair ? null : (requestedGroup || 1),
      groupCount: ROTATION_GROUPS.length,
      pairsSynced: pairs,
      totalJobs: results.length,
      success,
      failed,
      insertedTotal,
      results
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "sync-market-error")
    }, 500);
  }
}

async function syncOnePair(db, apiKey, pair, timeframe) {
  const symbolMeta = mapSymbolForProvider(pair);

  if (!symbolMeta) {
    throw new Error(`Unsupported pair ${pair}`);
  }

  const interval = mapTimeframeToProvider(timeframe);

  const apiUrl =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(symbolMeta.providerSymbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${OUTPUT_SIZE}` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const response = await fetch(apiUrl, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(data.message || "Twelve Data error");
  }

  if (!Array.isArray(data.values) || !data.values.length) {
    throw new Error("No candle values returned");
  }

  const candles = data.values
    .map((row) => ({
      pair,
      timeframe,
      ts: toUnixSeconds(row.datetime),
      open: roundPrice(Number(row.open), pair),
      high: roundPrice(Number(row.high), pair),
      low: roundPrice(Number(row.low), pair),
      close: roundPrice(Number(row.close), pair),
      source: "twelvedata-live"
    }))
    .filter((c) =>
      Number.isFinite(c.ts) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.ts > 0
    )
    .sort((a, b) => a.ts - b.ts);

  if (!candles.length) {
    throw new Error("No valid candles parsed");
  }

  let inserted = 0;

  for (let i = 0; i < candles.length; i += WRITE_CHUNK) {
    const chunk = candles.slice(i, i + WRITE_CHUNK);

    const statements = chunk.map((candle) =>
      db.prepare(`
        INSERT OR REPLACE INTO market_candles
        (pair, timeframe, ts, open, high, low, close, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        candle.pair,
        candle.timeframe,
        candle.ts,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.source
      )
    );

    await db.batch(statements);
    inserted += chunk.length;
  }

  return inserted;
}

function getPairsForGroup(groupNumber) {
  const index = groupNumber - 1;
  return ROTATION_GROUPS[index] || [];
}

function normalizeGroup(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return 0;
  if (n < 1 || n > ROTATION_GROUPS.length) return 0;
  return n;
}

function dedupeStrings(values) {
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

function isAuthorized(request, syncSecret) {
  if (!syncSecret) return true;

  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const url = new URL(request.url);
  const queryToken = String(url.searchParams.get("token") || "").trim();

  return bearer === syncSecret || queryToken === syncSecret;
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

function mapTimeframeToProvider(tf) {
  if (tf === "M5") return "5min";
  if (tf === "M15") return "15min";
  if (tf === "H1") return "1h";
  if (tf === "H4") return "4h";

  throw new Error(`Unsupported timeframe ${tf}`);
}

function toUnixSeconds(datetimeValue) {
  const ms = Date.parse(String(datetimeValue).trim());
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function roundPrice(value, symbol) {
  if (!Number.isFinite(value)) return 0;
  if (symbol === "XAUUSD") return Number(value.toFixed(2));
  if (symbol.includes("JPY")) return Number(value.toFixed(3));
  return Number(value.toFixed(5));
}

function cleanPair(value) {
  const v = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();

  return v || "";
}

function normalizeTimeframe(value) {
  const tf = String(value || "").toUpperCase().trim();
  return ["M5", "M15", "H1", "H4"].includes(tf) ? tf : "";
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
