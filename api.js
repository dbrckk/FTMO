import { API } from "./config.js";
import { appState, persistState } from "./state.js";

export async function fetchMlScore(scan) {
  const cacheKey = buildScanCacheKey(scan, "ml");

  if (appState.mlScoreCache?.[cacheKey]) {
    return appState.mlScoreCache[cacheKey];
  }

  const data = await postJson(API.ml, { scan });

  const result = {
    ok: Boolean(data?.ok),
    mlScore: Number(data?.mlScore ?? 50),
    confidenceBand: data?.confidenceBand || "medium",
    modelBias: data?.modelBias || "neutral",
    probability: Number(data?.probability ?? 0.5),
    components: data?.components || null,
    notes: Array.isArray(data?.notes) ? data.notes : []
  };

  appState.mlScoreCache = appState.mlScoreCache || {};
  appState.mlScoreCache[cacheKey] = result;

  return result;
}

export async function fetchVectorbtScore(scan) {
  const cacheKey = buildScanCacheKey(scan, "vectorbt");

  if (appState.vectorbtCache?.[cacheKey]) {
    return appState.vectorbtCache[cacheKey];
  }

  const data = await postJson(API.vectorbt, { scan });

  const result = {
    ok: Boolean(data?.ok),
    vectorbtScore: Number(data?.vectorbtScore ?? 55),
    confidenceBand: data?.confidenceBand || "medium",
    modelBias: data?.modelBias || "neutral",
    metrics: data?.metrics || null,
    notes: Array.isArray(data?.notes) ? data.notes : []
  };

  appState.vectorbtCache = appState.vectorbtCache || {};
  appState.vectorbtCache[cacheKey] = result;

  return result;
}

export async function refreshAiDecision(force = false, callback = null) {
  const pair = appState.selectedPair;

  if (!pair) return null;

  const scan = (appState.scans || []).find((item) => item.pair === pair);

  if (!scan) return null;

  const enrichedScan = enrichScanWithMtf(scan);

  if (!force && appState.aiDecisionCache?.[pair]) {
    if (typeof callback === "function") callback();
    return appState.aiDecisionCache[pair];
  }

  try {
    const data = await postJson(API.ai, { scan: enrichedScan });

    const decision = {
      ok: Boolean(data?.ok),
      pair,
      decision: data?.decision || "WAIT",
      action: data?.action || "WAIT",
      title: data?.title || "Décision IA",
      reason: data?.reason || "Aucune raison disponible.",
      confidence: Number(data?.confidence ?? enrichedScan.ultraScore ?? 50),
      window: data?.window || "Intraday",
      badge: data?.badge || data?.decision || "WAIT",
      riskMode: data?.riskMode || "normal",
      modelBias: data?.modelBias || "neutral",
      components: data?.components || null,
      blockers: Array.isArray(data?.blockers) ? data.blockers : [],
      notes: Array.isArray(data?.notes) ? data.notes : []
    };

    appState.aiDecisionCache = appState.aiDecisionCache || {};
    appState.aiDecisionCache[pair] = decision;

    persistState();

    if (typeof callback === "function") callback();

    return decision;
  } catch (error) {
    const fallback = {
      ok: false,
      pair,
      decision: "WAIT",
      action: "WAIT",
      title: "Décision IA indisponible",
      reason: String(error?.message || error || "ai-error"),
      confidence: 50,
      window: "Intraday",
      badge: "WAIT",
      riskMode: "no-risk",
      modelBias: "neutral",
      components: null,
      blockers: ["AI decision request failed."],
      notes: []
    };

    appState.aiDecisionCache = appState.aiDecisionCache || {};
    appState.aiDecisionCache[pair] = fallback;

    if (typeof callback === "function") callback();

    return fallback;
  }
}

export async function fetchExitSuggestion(scan, ai, box = null) {
  if (!scan) return null;

  const enrichedScan = enrichScanWithMtf(scan);

  try {
    const data = await postJson(API.exit, {
      scan: enrichedScan,
      ai: ai || {}
    });

    const result = {
      ok: Boolean(data?.ok),
      exitAction: data?.exitAction || "HOLD",
      exitScore: Number(data?.exitScore ?? 50),
      protection: data?.protection || "Normal hold",
      comment: data?.comment || "No exit signal.",
      shouldClose: Boolean(data?.shouldClose),
      shouldReduce: Boolean(data?.shouldReduce),
      shouldTrail: Boolean(data?.shouldTrail),
      components: data?.components || null,
      notes: Array.isArray(data?.notes) ? data.notes : []
    };

    if (box) {
      box.innerHTML = `
        Exit logic: ${escapeHtml(result.exitAction)}<br>
        Exit score: ${Math.round(result.exitScore)}<br>
        Protection: ${escapeHtml(result.protection)}<br>
        Comment: ${escapeHtml(result.comment)}
      `;
    }

    return result;
  } catch (error) {
    if (box) {
      box.innerHTML = `
        Exit logic: HOLD<br>
        Exit score: 50<br>
        Comment: Exit engine unavailable.
      `;
    }

    return {
      ok: false,
      exitAction: "HOLD",
      exitScore: 50,
      protection: "Fallback hold",
      comment: String(error?.message || error || "exit-error")
    };
  }
}

export async function fetchCorrelationMatrix() {
  try {
    const url = new URL(API.correlation, window.location.origin);
    url.searchParams.set("timeframe", appState.timeframe || "M15");
    url.searchParams.set("limit", "160");

    const data = await getJson(url.toString());

    appState.correlationMatrix = {
      ok: Boolean(data?.ok),
      pairs: Array.isArray(data?.pairs) ? data.pairs : [],
      matrix: Array.isArray(data?.matrix) ? data.matrix : [],
      alerts: Array.isArray(data?.alerts) ? data.alerts : [],
      clusters: Array.isArray(data?.clusters) ? data.clusters : [],
      cryptoPairs: Array.isArray(data?.cryptoPairs) ? data.cryptoPairs : [],
      metalPairs: Array.isArray(data?.metalPairs) ? data.metalPairs : []
    };

    persistState();

    return appState.correlationMatrix;
  } catch {
    appState.correlationMatrix = {
      ok: false,
      pairs: [],
      matrix: [],
      alerts: [],
      clusters: [],
      cryptoPairs: [],
      metalPairs: []
    };

    return appState.correlationMatrix;
  }
}

export async function fetchArchiveStatsBatch() {
  const timeframe = appState.timeframe || "M15";
  const cacheKey = `archive_${timeframe}`;

  if (appState.archiveStatsCache?.__key === cacheKey) {
    return appState.archiveStatsCache;
  }

  try {
    const url = new URL(API.archiveStats, window.location.origin);
    url.searchParams.set("timeframe", timeframe);

    const data = await getJson(url.toString());
    const stats = data?.stats && typeof data.stats === "object" ? data.stats : {};

    appState.archiveStatsCache = {
      __key: cacheKey,
      ...stats
    };

    persistState();

    return appState.archiveStatsCache;
  } catch {
    appState.archiveStatsCache = {
      __key: cacheKey
    };

    return appState.archiveStatsCache;
  }
}

export async function fetchServerPaperSnapshot() {
  try {
    const url = new URL(API.paperTrades, window.location.origin);
    url.searchParams.set("timeframe", appState.timeframe || "M15");
    url.searchParams.set("limit", "80");

    const data = await getJson(url.toString());

    appState.serverPaperSnapshot = {
      ok: Boolean(data?.ok),
      timeframe: data?.timeframe || appState.timeframe || "M15",
      summary: data?.summary || null,
      open: Array.isArray(data?.open) ? data.open : [],
      recent: Array.isArray(data?.recent) ? data.recent : [],
      pairStats: Array.isArray(data?.pairStats) ? data.pairStats : [],
      runs: Array.isArray(data?.runs) ? data.runs : []
    };

    persistState();

    return appState.serverPaperSnapshot;
  } catch {
    appState.serverPaperSnapshot = {
      ok: false,
      summary: null,
      open: [],
      recent: [],
      pairStats: [],
      runs: []
    };

    return appState.serverPaperSnapshot;
  }
}

export async function fetchPaperHealth() {
  try {
    const url = new URL(API.paperHealth, window.location.origin);
    url.searchParams.set("timeframe", appState.timeframe || "M15");

    const data = await getJson(url.toString());

    appState.paperHealth = {
      ok: Boolean(data?.ok),
      healthy: Boolean(data?.healthy),
      status: data?.status || "UNKNOWN",
      timeframe: data?.timeframe || appState.timeframe || "M15",
      market: data?.market || null,
      paper: data?.paper || null
    };

    persistState();

    return appState.paperHealth;
  } catch {
    appState.paperHealth = {
      ok: false,
      healthy: false,
      status: "ERROR",
      market: null,
      paper: null
    };

    return appState.paperHealth;
  }
}

export async function fetchTimeframeSummary() {
  try {
    const url = new URL(API.timeframeSummary, window.location.origin);
    url.searchParams.set("includeM5", "0");

    const data = await getJson(url.toString());

    appState.timeframeSummary = {
      ok: Boolean(data?.ok),
      source: data?.source || "timeframe-summary",
      version: data?.version || "",
      generatedAt: data?.generatedAt || "",
      timeframes: Array.isArray(data?.timeframes) ? data.timeframes : ["M15", "H1", "H4"],
      mtfAlignment: data?.mtfAlignment || {
        best: null,
        topPairs: []
      },
      summary: data?.summary || {}
    };

    persistState();

    return appState.timeframeSummary;
  } catch {
    appState.timeframeSummary = {
      ok: false,
      mtfAlignment: {
        best: null,
        topPairs: []
      },
      summary: {}
    };

    return appState.timeframeSummary;
  }
}

export async function saveClosedPaperTrade(trade) {
  try {
    const data = await postJson(API.paperTrades, { trade });

    return {
      ok: Boolean(data?.ok),
      saved: Boolean(data?.saved),
      trade: data?.trade || trade
    };
  } catch {
    return {
      ok: false,
      saved: false,
      trade
    };
  }
}

function enrichScanWithMtf(scan) {
  const mtf = getMtfForPair(scan.pair);

  if (!mtf) {
    return {
      ...scan,
      mtfScore: Number(scan.mtfScore || 0),
      mtfSignal: scan.mtfSignal || "",
      mtfLabel: scan.mtfLabel || ""
    };
  }

  return {
    ...scan,
    mtfScore: Number(mtf.score || scan.mtfScore || 0),
    mtfSignal: String(mtf.signal || scan.mtfSignal || "").toUpperCase(),
    mtfLabel: mtf.label || scan.mtfLabel || "",
    mtfTimeframes: Array.isArray(mtf.timeframes) ? mtf.timeframes : []
  };
}

function getMtfForPair(pair) {
  const mtf = appState.timeframeSummary?.mtfAlignment;
  const topPairs = Array.isArray(mtf?.topPairs) ? mtf.topPairs : [];

  return topPairs.find((item) => item.pair === pair) || null;
}

function buildScanCacheKey(scan, prefix) {
  const pair = String(scan?.pair || "UNKNOWN").toUpperCase();
  const timeframe = String(scan?.timeframe || appState.timeframe || "M15").toUpperCase();
  const candleTime = Number(scan?.candles?.at?.(-1)?.time || scan?.candles?.at?.(-1)?.ts || 0);
  const ultra = Number(scan?.ultraScore || scan?.finalScore || 0);

  return `${prefix}_${pair}_${timeframe}_${candleTime}_${Math.round(ultra)}`;
}

async function getJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error || `GET ${response.status}`);
  }

  return data;
}

async function postJson(path, payload) {
  const url = path.startsWith("http")
    ? path
    : new URL(path, window.location.origin).toString();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error || `POST ${response.status}`);
  }

  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
                        }
