const MODEL_VERSION = "server-trading-v4-full-orchestrator";

const DEFAULT_TIMEFRAME = "M15";

export async function onRequestGet(context) {
  return handleServerTrading(context);
}

export async function onRequestPost(context) {
  return handleServerTrading(context);
}

async function handleServerTrading(context) {
  const startedAt = Date.now();

  try {
    const env = context.env || {};
    const db = env.DB;

    if (!db) {
      return json({
        ok: false,
        source: "server-trading",
        version: MODEL_VERSION,
        error: "Missing DB binding"
      }, 500);
    }

    if (!isAuthorized(context.request, env.SYNC_SECRET || "")) {
      return json({
        ok: false,
        source: "server-trading",
        version: MODEL_VERSION,
        error: "Unauthorized"
      }, 401);
    }

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    const origin = url.origin;
    const token = env.SYNC_SECRET || "";

    const timeframes = parseTimeframes(
      url.searchParams.get("timeframes") ||
      url.searchParams.get("timeframe") ||
      body.timeframes ||
      body.timeframe ||
      DEFAULT_TIMEFRAME
    );

    const dryRun = readBool(url, body, "dryRun", false);
    const runSync = readBool(url, body, "sync", true);
    const runHealth = readBool(url, body, "health", true);
    const runPaper = readBool(url, body, "paper", true);
    const runAlerts = readBool(url, body, "alerts", true);
    const runAnalytics = readBool(url, body, "analytics", true);
    const forceAlerts = readBool(url, body, "forceAlerts", false);
    const telegram = readBool(url, body, "telegram", true);

    const results = {
      sync: [],
      health: [],
      ftmo: [],
      paper: [],
      alerts: null,
      analytics: null
    };

    if (runSync) {
      for (const timeframe of timeframes) {
        results.sync.push(
          await callEndpoint(origin, "/api/sync-market", token, {
            timeframe
          })
        );
      }
    }

    if (runHealth) {
      for (const timeframe of timeframes) {
        results.health.push(
          await callEndpoint(origin, "/api/paper-health", token, {
            timeframe,
            marketAware: "1",
            strict: "0"
          })
        );
      }
    }

    for (const timeframe of timeframes) {
      results.ftmo.push(
        await callEndpoint(origin, "/api/ftmo-status", token, {
          timeframe
        })
      );
    }

    if (runPaper) {
      for (const timeframe of timeframes) {
        results.paper.push(
          await callEndpoint(origin, "/api/paper-run", token, {
            timeframe,
            dryRun: dryRun ? "1" : "0"
          })
        );
      }
    }

    if (runAlerts) {
      results.alerts = await callEndpoint(origin, "/api/setup-alerts", token, {
        timeframes: timeframes.join(","),
        dryRun: dryRun ? "1" : "0",
        forceAlerts: forceAlerts ? "1" : "0",
        telegram: telegram ? "1" : "0",
        alerts: "1",
        refreshAnalytics: runAnalytics ? "1" : "0"
      });
    }

    if (runAnalytics && !runAlerts) {
      results.analytics = await callEndpoint(origin, "/api/analytics-engine", token, {
        minTrades: "8"
      });
    }

    const summary = buildSummary(results, {
      timeframes,
      dryRun,
      runSync,
      runHealth,
      runPaper,
      runAlerts,
      runAnalytics,
      forceAlerts,
      telegram
    });

    await insertServerTradingRun(db, {
      summary,
      results,
      durationMs: Date.now() - startedAt
    });

    const ok = summary.failed === 0;

    return json({
      ok,
      source: "server-trading",
      version: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      timeframes,
      dryRun,
      summary,
      results
    }, ok ? 200 : 207);
  } catch (error) {
    return json({
      ok: false,
      source: "server-trading",
      version: MODEL_VERSION,
      error: String(error?.message || error || "server-trading-error")
    }, 500);
  }
}

async function callEndpoint(origin, path, token, params = {}) {
  const startedAt = Date.now();

  try {
    const endpoint = new URL(`${origin}${path}`);

    if (token) {
      endpoint.searchParams.set("token", token);
    }

    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") {
        endpoint.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Cache-Control": "no-store"
      }
    });

    const data = await safeResponseJson(response);

    return {
      ok: response.ok && data.ok !== false,
      status: response.status,
      path,
      durationMs: Date.now() - startedAt,
      data
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      path,
      durationMs: Date.now() - startedAt,
      error: String(error?.message || error || "endpoint-call-error")
    };
  }
}

function buildSummary(results, options) {
  const calls = [
    ...results.sync,
    ...results.health,
    ...results.ftmo,
    ...results.paper,
    results.alerts,
    results.analytics
  ].filter(Boolean);

  const failed = calls.filter((item) => !item.ok).length;

  const opened = results.paper.reduce((sum, item) => {
    return sum + Number(item?.data?.opened || 0);
  }, 0);

  const closed = results.paper.reduce((sum, item) => {
    return sum + Number(item?.data?.closed || 0);
  }, 0);

  const scannedPairs = results.paper.reduce((sum, item) => {
    return sum + Number(item?.data?.scannedPairs || 0);
  }, 0);

  const alertsSent = Number(results.alerts?.data?.summary?.sent || 0);
  const alertsEligible = Number(results.alerts?.data?.summary?.eligible || 0);

  const healthFresh = results.health.reduce((sum, item) => {
    return sum + Number(item?.data?.freshPairs || 0);
  }, 0);

  const healthStale = results.health.reduce((sum, item) => {
    return sum + Number(item?.data?.stalePairs || 0);
  }, 0);

  const healthMissing = results.health.reduce((sum, item) => {
    return sum + Number(item?.data?.missingPairs || 0);
  }, 0);

  const ftmoStatuses = results.ftmo.map((item) => ({
    timeframe: item?.data?.timeframe || null,
    ok: item?.ok === true,
    status: item?.data?.status || item?.data?.ftmoStatus || null,
    decision: item?.data?.decision || null
  }));

  return {
    ok: failed === 0,
    failed,
    calls: calls.length,

    dryRun: options.dryRun,
    timeframes: options.timeframes,

    syncEnabled: options.runSync,
    healthEnabled: options.runHealth,
    paperEnabled: options.runPaper,
    alertsEnabled: options.runAlerts,
    analyticsEnabled: options.runAnalytics,
    telegramEnabled: options.telegram,
    forceAlerts: options.forceAlerts,

    scannedPairs,
    opened,
    closed,

    alertsEligible,
    alertsSent,

    health: {
      freshPairs: healthFresh,
      stalePairs: healthStale,
      missingPairs: healthMissing
    },

    ftmoStatuses
  };
}

async function insertServerTradingRun(db, data) {
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS server_trading_runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        version TEXT,
        ok INTEGER,
        duration_ms INTEGER,
        summary_json TEXT,
        payload_json TEXT
      )
    `).run();

    await db.prepare(`
      INSERT INTO server_trading_runs (
        id,
        created_at,
        version,
        ok,
        duration_ms,
        summary_json,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      `server_trading_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      new Date().toISOString(),
      MODEL_VERSION,
      data.summary?.ok ? 1 : 0,
      Number(data.durationMs || 0),
      JSON.stringify(data.summary || {}),
      JSON.stringify(data.results || {})
    ).run();
  } catch {
    // Optional log table.
  }
}

function parseTimeframes(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || DEFAULT_TIMEFRAME);

  const timeframes = raw
    .split(",")
    .map((item) => normalizeTimeframe(item))
    .filter(Boolean);

  return [...new Set(timeframes.length ? timeframes : [DEFAULT_TIMEFRAME])];
}

function normalizeTimeframe(value) {
  const tf = String(value || "").toUpperCase().trim();

  return ["M5", "M15", "H1", "H4"].includes(tf) ? tf : "";
}

function readBool(url, body, key, fallback = false) {
  const queryValue = url.searchParams.get(key);

  if (queryValue !== null && queryValue !== undefined && queryValue !== "") {
    return queryValue === "1" || queryValue.toLowerCase() === "true";
  }

  const bodyValue = body?.[key];

  if (bodyValue !== null && bodyValue !== undefined && bodyValue !== "") {
    if (typeof bodyValue === "boolean") return bodyValue;
    return String(bodyValue) === "1" || String(bodyValue).toLowerCase() === "true";
  }

  return fallback;
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

async function safeResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
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
