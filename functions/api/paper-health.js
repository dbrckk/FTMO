const MODEL_VERSION = "paper-health-v2-market-aware";

const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

const DEFAULT_TIMEFRAME = "M15";

const FRESHNESS_SECONDS = {
  M5: 60 * 60,
  M15: 3 * 60 * 60,
  H1: 8 * 60 * 60,
  H4: 24 * 60 * 60
};

const MIN_FRESH_PAIRS_MARKET_OPEN = 16;
const MIN_FRESH_PAIRS_MARKET_CLOSED = 1;
const MAX_MISSING_PAIRS = 2;

export async function onRequestGet(context) {
  return handlePaperHealth(context);
}

export async function onRequestPost(context) {
  return handlePaperHealth(context);
}

async function handlePaperHealth(context) {
  try {
    const env = context.env || {};
    const db = env.DB;

    if (!db) {
      return json({
        ok: false,
        healthy: false,
        source: "paper-health",
        version: MODEL_VERSION,
        error: "Missing DB binding"
      }, 500);
    }

    if (!isAuthorized(context.request, env.SYNC_SECRET || "")) {
      return json({
        ok: false,
        healthy: false,
        source: "paper-health",
        version: MODEL_VERSION,
        error: "Unauthorized"
      }, 401);
    }

    const url = new URL(context.request.url);

    const timeframe =
      normalizeTimeframe(url.searchParams.get("timeframe")) ||
      DEFAULT_TIMEFRAME;

    const strict = readBool(url, "strict", false);
    const marketAware = readBool(url, "marketAware", true);

    const minFreshPairs = Number(
      url.searchParams.get("minFreshPairs") ||
      env.PAPER_HEALTH_MIN_FRESH_PAIRS ||
      MIN_FRESH_PAIRS_MARKET_OPEN
    );

    const maxMissingPairs = Number(
      url.searchParams.get("maxMissingPairs") ||
      env.PAPER_HEALTH_MAX_MISSING_PAIRS ||
      MAX_MISSING_PAIRS
    );

    const market = getMarketStatus(new Date());
    const nowSeconds = Math.floor(Date.now() / 1000);
    const maxAge = getMaxAgeSeconds(timeframe, market);

    const checks = [];

    for (const pair of PAIRS) {
      checks.push(await checkPair(db, pair, timeframe, nowSeconds, maxAge));
    }

    const freshPairs = checks.filter((item) => item.status === "fresh");
    const stalePairs = checks.filter((item) => item.status === "stale");
    const missingPairs = checks.filter((item) => item.status === "missing");

    const latestTs = Math.max(
      0,
      ...checks.map((item) => Number(item.lastTs || 0))
    );

    const lastRun = latestTs
      ? new Date(latestTs * 1000).toISOString()
      : null;

    const effectiveMinFresh = marketAware && !market.isTradingWindow
      ? MIN_FRESH_PAIRS_MARKET_CLOSED
      : minFreshPairs;

    const healthy =
      missingPairs.length <= maxMissingPairs &&
      freshPairs.length >= effectiveMinFresh;

    const degraded =
      !healthy &&
      missingPairs.length <= maxMissingPairs &&
      freshPairs.length > 0;

    const shouldFail =
      strict
        ? !healthy
        : marketAware && !market.isTradingWindow
          ? false
          : !healthy;

    const payload = {
      ok: !shouldFail,
      healthy,
      degraded,
      source: "paper-health",
      version: MODEL_VERSION,
      generatedAt: new Date().toISOString(),

      timeframe,
      strict,
      marketAware,
      market,

      totalPairs: PAIRS.length,
      freshPairs: freshPairs.length,
      stalePairs: stalePairs.length,
      missingPairs: missingPairs.length,

      minFreshPairs: effectiveMinFresh,
      maxMissingPairs,
      maxAgeSeconds: maxAge,

      lastRun,

      statusText: buildStatusText({
        healthy,
        degraded,
        market,
        freshPairs: freshPairs.length,
        stalePairs: stalePairs.length,
        missingPairs: missingPairs.length
      }),

      pairs: checks,

      groups: {
        fresh: freshPairs.map((item) => item.pair),
        stale: stalePairs.map((item) => ({
          pair: item.pair,
          ageMinutes: item.ageMinutes,
          lastCandle: item.lastCandle
        })),
        missing: missingPairs.map((item) => item.pair)
      }
    };

    return json(payload, shouldFail ? 503 : 200);
  } catch (error) {
    return json({
      ok: false,
      healthy: false,
      source: "paper-health",
      version: MODEL_VERSION,
      error: String(error?.message || error || "paper-health-error")
    }, 500);
  }
}

async function checkPair(db, pair, timeframe, nowSeconds, maxAgeSeconds) {
  try {
    const row = await db.prepare(`
      SELECT
        ts,
        close
      FROM market_candles
      WHERE pair = ?
        AND timeframe = ?
      ORDER BY ts DESC
      LIMIT 1
    `).bind(pair, timeframe).first();

    if (!row || !row.ts) {
      return {
        pair,
        timeframe,
        status: "missing",
        lastTs: 0,
        lastCandle: null,
        ageSeconds: null,
        ageMinutes: null,
        close: null
      };
    }

    const lastTs = Number(row.ts || 0);
    const ageSeconds = Math.max(0, nowSeconds - lastTs);
    const ageMinutes = Math.round(ageSeconds / 60);

    return {
      pair,
      timeframe,
      status: ageSeconds <= maxAgeSeconds ? "fresh" : "stale",
      lastTs,
      lastCandle: new Date(lastTs * 1000).toISOString(),
      ageSeconds,
      ageMinutes,
      close: Number(row.close || 0)
    };
  } catch (error) {
    return {
      pair,
      timeframe,
      status: "missing",
      lastTs: 0,
      lastCandle: null,
      ageSeconds: null,
      ageMinutes: null,
      close: null,
      error: String(error?.message || error || "pair-check-error")
    };
  }
}

function getMaxAgeSeconds(timeframe, market) {
  const base = FRESHNESS_SECONDS[timeframe] || FRESHNESS_SECONDS.M15;

  if (!market.isTradingWindow) {
    return Math.max(base, 72 * 60 * 60);
  }

  if (market.isRolloverWindow) {
    return Math.max(base, 8 * 60 * 60);
  }

  return base;
}

function getMarketStatus(date = new Date()) {
  const paris = getParisParts(date);
  const day = paris.day;
  const hour = paris.hour;
  const minute = paris.minute;

  const isSaturday = day === 6;
  const isSunday = day === 0;
  const isMonday = day === 1;
  const isFriday = day === 5;

  const isWeekend =
    isSaturday ||
    isSunday ||
    (isFriday && hour >= 23) ||
    (isMonday && hour < 1);

  const isRolloverWindow =
    hour === 22 ||
    hour === 23 ||
    (hour === 0 && minute <= 30);

  return {
    timezone: "Europe/Paris",
    day,
    hour,
    minute,
    isWeekend,
    isRolloverWindow,
    isTradingWindow: !isWeekend,
    label:
      isWeekend ? "market-closed" :
      isRolloverWindow ? "rollover" :
      "market-open"
  };
}

function getParisParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const weekday = parts.find((part) => part.type === "weekday")?.value || "Mon";
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);

  const map = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    day: map[weekday] ?? 1,
    hour,
    minute
  };
}

function buildStatusText(data) {
  if (data.healthy) {
    return `Healthy: ${data.freshPairs} fresh, ${data.stalePairs} stale, ${data.missingPairs} missing.`;
  }

  if (data.degraded && !data.market.isTradingWindow) {
    return `Degraded but tolerated: market is closed, ${data.freshPairs} fresh, ${data.stalePairs} stale.`;
  }

  if (data.degraded) {
    return `Degraded: ${data.freshPairs} fresh, ${data.stalePairs} stale, ${data.missingPairs} missing.`;
  }

  return `Unhealthy: ${data.freshPairs} fresh, ${data.stalePairs} stale, ${data.missingPairs} missing.`;
}

function normalizeTimeframe(value) {
  const timeframe = String(value || "").toUpperCase().trim();

  return ["M5", "M15", "H1", "H4"].includes(timeframe) ? timeframe : "";
}

function readBool(url, key, fallback = false) {
  const value = url.searchParams.get(key);

  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value) === "1" || String(value).toLowerCase() === "true";
}

function isAuthorized(request, secret) {
  if (!secret) return true;

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  return token === secret || bearer === secret;
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
