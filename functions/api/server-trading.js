const MODEL_VERSION = "server-trading-orchestrator-v1";

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
    const secret = env.SYNC_SECRET || "";

    if (!isAuthorized(context.request, secret)) {
      return json({
        ok: false,
        source: "server-trading",
        version: MODEL_VERSION,
        error: "Unauthorized"
      }, 401);
    }

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    const dryRun = readBool(url, body, "dryRun", false);
    const alerts = readBool(url, body, "alerts", true);
    const runPaper = readBool(url, body, "paper", true);
    const forceAlerts = readBool(url, body, "forceAlerts", false);

    const timeframes = parseTimeframes(
      url.searchParams.get("timeframes") ||
      body.timeframes ||
      "M15"
    );

    const results = [];

    for (const timeframe of timeframes) {
      const ftmo = await callInternalApi(context.request, env, "/api/ftmo-status", {
        timeframe
      });

      let paper = null;
      let setupAlerts = null;

      if (runPaper) {
        paper = await callInternalApi(context.request, env, "/api/paper-run", {
          timeframe,
          dryRun: dryRun ? "1" : "0"
        });
      }

      if (alerts) {
        setupAlerts = await callInternalApi(context.request, env, "/api/setup-alerts", {
          timeframe,
          dryRun: dryRun ? "1" : "0",
          force: forceAlerts ? "1" : "0"
        });
      }

      results.push({
        timeframe,
        ftmo: summarizeFtmo(ftmo),
        paper: summarizePaper(paper),
        alerts: summarizeAlerts(setupAlerts),
        raw: {
          ftmo,
          paper,
          setupAlerts
        }
      });
    }

    const durationMs = Date.now() - startedAt;

    return json({
      ok: true,
      source: "server-trading",
      version: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      dryRun,
      alerts,
      paper: runPaper,
      timeframes,
      durationMs,
      summary: buildSummary(results),
      results
    });
  } catch (error) {
    return json({
      ok: false,
      source: "server-trading",
      version: MODEL_VERSION,
      error: String(error?.message || error || "server-trading-error")
    }, 500);
  }
}

async function callInternalApi(request, env, pathname, params = {}) {
  const target = new URL(pathname, request.url);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      target.searchParams.set(key, String(value));
    }
  }

  if (env.SYNC_SECRET) {
    target.searchParams.set("token", env.SYNC_SECRET);
  }

  try {
    const response = await fetch(target.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Cache-Control": "no-store"
      }
    });

    const data = await response.json().catch(() => ({
      ok: false,
      error: "Invalid JSON response"
    }));

    return {
      ok: response.ok && data.ok !== false,
      status: response.status,
      ...data
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      source: pathname,
      error: String(error?.message || error || "internal-api-error")
    };
  }
}

function summarizeFtmo(ftmo) {
  if (!ftmo) return null;

  return {
    ok: ftmo.ok,
    status: ftmo.status?.level || ftmo.status?.label || "unknown",
    locked: Boolean(ftmo.status?.locked),
    healthScore: ftmo.status?.healthScore ?? null,
    canTrade: Boolean(ftmo.decision?.canTrade),
    canOpenNewTrade: Boolean(ftmo.decision?.canOpenNewTrade),
    recommendedMaxRiskPercent: ftmo.decision?.recommendedMaxRiskPercent ?? 0,
    equity: ftmo.metrics?.equity ?? 0,
    balance: ftmo.metrics?.balance ?? 0,
    dailyLossRemaining: ftmo.metrics?.dailyLossRemaining ?? 0,
    totalLossRemaining: ftmo.metrics?.totalLossRemaining ?? 0,
    openRisk: ftmo.metrics?.openRisk ?? 0,
    dailyTrades: ftmo.metrics?.dailyTrades ?? 0,
    dailyLosses: ftmo.metrics?.dailyLosses ?? 0,
    reason: ftmo.decision?.reason || ftmo.status?.reason || ""
  };
}

function summarizePaper(paper) {
  if (!paper) return null;

  const candidates = Array.isArray(paper.topCandidates) ? paper.topCandidates : [];
  const valid = candidates.filter((item) => item?.tradeAllowed === true);
  const ftmoValid = valid.filter((item) => item?.ftmoAllowed !== false);

  return {
    ok: paper.ok,
    dryRun: Boolean(paper.dryRun),
    scannedPairs: paper.scannedPairs || 0,
    opened: paper.opened || 0,
    closed: paper.closed || 0,
    openBefore: paper.openBefore || 0,
    openAfter: paper.openAfter || 0,
    validCandidates: valid.length,
    ftmoValidCandidates: ftmoValid.length,
    bestCandidate: candidates[0]
      ? {
          pair: candidates[0].pair,
          signal: candidates[0].signal,
          paperScore: candidates[0].paperScore,
          ultraScore: candidates[0].ultraScore,
          entryQualityScore: candidates[0].entryQualityScore,
          ftmoAllowed: candidates[0].ftmoAllowed,
          ftmoRisk: candidates[0].ftmoRecommendedRiskPercent,
          reason: candidates[0].ftmoReason || candidates[0].tradeReason
        }
      : null
  };
}

function summarizeAlerts(alerts) {
  if (!alerts) return null;

  return {
    ok: alerts.ok,
    dryRun: Boolean(alerts.dryRun),
    candidates: alerts.candidates || 0,
    validCandidates: alerts.validCandidates || 0,
    sent: alerts.sent || 0,
    skipped: alerts.skipped || 0,
    results: Array.isArray(alerts.results)
      ? alerts.results.map((item) => ({
          pair: item.pair,
          signal: item.signal,
          status: item.status,
          reason: item.reason || ""
        }))
      : []
  };
}

function buildSummary(results) {
  const summary = {
    totalTimeframes: results.length,
    ftmoLocked: 0,
    paperOpened: 0,
    paperClosed: 0,
    alertsSent: 0,
    bestCandidates: []
  };

  for (const result of results) {
    if (result.ftmo?.locked) summary.ftmoLocked += 1;
    summary.paperOpened += Number(result.paper?.opened || 0);
    summary.paperClosed += Number(result.paper?.closed || 0);
    summary.alertsSent += Number(result.alerts?.sent || 0);

    if (result.paper?.bestCandidate) {
      summary.bestCandidates.push({
        timeframe: result.timeframe,
        ...result.paper.bestCandidate
      });
    }
  }

  return summary;
}

function parseTimeframes(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim());

  const allowed = new Set(["M5", "M15", "H1", "H4"]);

  const result = raw
    .map((item) => String(item || "").toUpperCase())
    .filter((item) => allowed.has(item));

  return result.length ? [...new Set(result)] : ["M15"];
}

function readBool(url, body, key, fallback = false) {
  const value = url.searchParams.get(key) ?? body?.[key];

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
      }
