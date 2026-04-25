const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

const ROTATION_GROUPS = 11;
const OUTPUT_SIZE = 200;

const TIMEFRAME_TO_PROVIDER_INTERVAL = {
  M5: "5min",
  M15: "15min",
  H1: "1h",
  H4: "4h"
};

export async function onRequestGet(context) {
  return handleSyncMarket(context);
}

export async function onRequestPost(context) {
  return handleSyncMarket(context);
}

async function handleSyncMarket(context) {
  try {
    const env = context.env || {};
    const db = env.DB;
    const secret = env.SYNC_SECRET || "";
    const apiKey =
      env.TWELVE_DATA_API_KEY ||
      env.TWELVEDATA_API_KEY ||
      env.TWELVE_API_KEY ||
      "";

    if (!db) {
      return json({ ok: false, error: "Missing DB binding" }, 500);
    }

    if (!apiKey) {
      return json({ ok: false, error: "Missing Twelve Data API key" }, 500);
    }

    if (!isAuthorized(context.request, secret)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    const timeframe =
      normalizeTimeframe(url.searchParams.get("timeframe") || body.timeframe) ||
      "M15";

    const group = normalizeGroup(url.searchParams.get("group") || body.group);
    const pairs = getPairsForGroup(group);

    const results = [];

    for (const pair of pairs) {
      const result = await syncPair(db, apiKey, pair, timeframe);
      results.push(result);

      await sleep(250);
    }

    const inserted = results.reduce((sum, row) => sum + Number(row.inserted || 0), 0);
    const failed = results.filter((row) => !row.ok).length;

    return json({
      ok: failed === 0,
      source: "sync-market",
      version: "twelve-data-d1-btc-v2",
      timeframe,
      providerInterval: TIMEFRAME_TO_PROVIDER_INTERVAL[timeframe],
      group,
      rotationGroups: ROTATION_GROUPS,
      requestedPairs: pairs.length,
      inserted,
      failed,
      results
    }, failed === 0 ? 200 : 207);
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "sync-market-error")
    }, 500);
  }
}

async function syncPair(db, apiKey, pair, timeframe) {
  try {
    const providerSymbol = toProviderSymbol(pair);
    const interval = TIMEFRAME_TO_PROVIDER_INTERVAL[timeframe] || "15min";

    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", providerSymbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("outputsize", String(OUTPUT_SIZE));
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("format", "JSON");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        ok: false,
        pair,
        providerSymbol,
        timeframe,
        error: `Provider HTTP ${response.status}`
      };
    }

    if (!data || data.status === "error" || data.code) {
      return {
        ok: false,
        pair,
        providerSymbol,
        timeframe,
        error: data?.message || data?.status || "Provider error"
      };
    }

    const values = Array.isArray(data.values) ? data.values : [];

    if (!values.length) {
      return {
        ok: false,
        pair,
        providerSymbol,
        timeframe,
        error: "No candles returned"
      };
    }

    const candles = values
      .map((row) => normalizeProviderCandle(row))
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);

    let inserted = 0;

    for (const candle of candles) {
      await db
        .prepare(`
          INSERT OR REPLACE INTO market_candles (
            pair,
            timeframe,
            ts,
            open,
            high,
            low,
            close
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          pair,
          timeframe,
          candle.ts,
          candle.open,
          candle.high,
          candle.low,
          candle.close
        )
        .run();

      inserted += 1;
    }

    const last = candles.at(-1) || null;

    return {
      ok: true,
      pair,
      providerSymbol,
      timeframe,
      inserted,
      firstTs: candles[0]?.ts || null,
      lastTs: last?.ts || null,
      lastClose: last?.close || null
    };
  } catch (error) {
    return {
      ok: false,
      pair,
      timeframe,
      error: String(error?.message || error || "sync-pair-error")
    };
  }
}

function normalizeProviderCandle(row) {
  const ts = parseProviderTimestamp(row.datetime || row.date || row.timestamp);

  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);

  if (
    !Number.isFinite(ts) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    close <= 0
  ) {
    return null;
  }

  return {
    ts,
    open,
    high,
    low,
    close
  };
}

function parseProviderTimestamp(value) {
  if (!value) return 0;

  if (typeof value === "number") {
    return value > 1000000000000 ? Math.floor(value / 1000) : Math.floor(value);
  }

  const raw = String(value).trim();

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1000000000000 ? Math.floor(n / 1000) : Math.floor(n);
  }

  const isoLike = raw.includes("T") ? raw : raw.replace(" ", "T");
  const hasZone = /Z$|[+-]\d{2}:\d{2}$/.test(isoLike);
  const ms = Date.parse(hasZone ? isoLike : `${isoLike}Z`);

  if (!Number.isFinite(ms)) return 0;

  return Math.floor(ms / 1000);
}

function getPairsForGroup(group) {
  const g = Number(group || 1);

  return PAIRS.filter((_, index) => {
    return index % ROTATION_GROUPS === g - 1;
  });
}

function normalizeGroup(value) {
  const n = Number(value || 1);

  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > ROTATION_GROUPS) return ROTATION_GROUPS;

  return Math.round(n);
}

function normalizeTimeframe(value) {
  const tf = String(value || "").toUpperCase().trim();
  return ["M5", "M15", "H1", "H4"].includes(tf) ? tf : "";
}

function toProviderSymbol(pair) {
  const p = String(pair || "").toUpperCase().trim();

  if (p === "BTCUSD") return "BTC/USD";
  if (p === "XAUUSD") return "XAU/USD";

  if (p.length === 6) {
    return `${p.slice(0, 3)}/${p.slice(3)}`;
  }

  return p;
}

function isAuthorized(request, secret) {
  if (!secret) return true;

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  return token === secret || bearer === secret;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
