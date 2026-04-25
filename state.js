import { STORAGE_KEY, PAIRS } from "./config.js";

export const STATE_VERSION = "ftmo-edge-ai-btc-v3";

export const els = {};

const DEFAULT_STATE = {
  stateVersion: STATE_VERSION,

  activeTab: "dashboard",
  timeframe: "M15",
  selectedPair: "EURUSD",

  scans: [],
  trades: [],
  watchlist: [],

  correlationMatrix: {
    ok: false,
    pairs: [],
    matrix: [],
    alerts: [],
    clusters: [],
    cryptoPairs: [],
    metalPairs: []
  },

  timeframeSummary: {
    ok: false,
    source: "timeframe-summary",
    version: "",
    generatedAt: "",
    timeframes: ["M15", "H1", "H4"],
    mtfAlignment: {
      best: null,
      topPairs: []
    },
    summary: {}
  },

  serverPaperSnapshot: {
    ok: false,
    summary: null,
    open: [],
    recent: [],
    pairStats: [],
    runs: []
  },

  paperHealth: {
    ok: false,
    healthy: false,
    status: "UNKNOWN",
    market: null,
    paper: null
  },

  paperTrades: [],
  paperArchive: [],

  paperEngine: {
    enabled: true,
    autoRun: true,
    maxOpenTrades: 4,
    minUltraScore: 72,
    explorationScore: 58,
    riskPerTrade: 0.25,
    explorationRiskPerTrade: 0.1,
    maxBarsHold: 12,
    refreshIntervalMs: 20000
  },

  ftmo: {
    accountSize: 10000,
    requestedRiskPercent: 1,
    dailyLossLimitPercent: 5,
    maxLossLimitPercent: 10,
    closedTodayPnl: 0,
    totalClosedPnl: 0
  },

  mlScoreCache: {},
  vectorbtCache: {},
  aiDecisionCache: {},
  archiveStatsCache: {},

  lastRefreshAt: "",
  lastSelectedAt: ""
};

export const appState = createInitialState();

function createInitialState() {
  const saved = loadSavedState();
  const merged = deepMerge(structuredCloneSafe(DEFAULT_STATE), saved || {});

  migrateState(merged);
  sanitizeState(merged);

  return merged;
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) return null;

    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function persistState() {
  try {
    appState.stateVersion = STATE_VERSION;

    const cleanState = structuredCloneSafe(appState);

    delete cleanState.els;

    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleanState));
  } catch (error) {
    console.warn("persistState failed", error);
  }
}

export function resetState() {
  const fresh = structuredCloneSafe(DEFAULT_STATE);

  Object.keys(appState).forEach((key) => {
    delete appState[key];
  });

  Object.assign(appState, fresh);
  persistState();
}

export function clearRuntimeCaches() {
  appState.mlScoreCache = {};
  appState.vectorbtCache = {};
  appState.aiDecisionCache = {};
  appState.archiveStatsCache = {};
  appState.serverPaperSnapshot = structuredCloneSafe(DEFAULT_STATE.serverPaperSnapshot);
  appState.paperHealth = structuredCloneSafe(DEFAULT_STATE.paperHealth);
  appState.timeframeSummary = structuredCloneSafe(DEFAULT_STATE.timeframeSummary);
  appState.correlationMatrix = structuredCloneSafe(DEFAULT_STATE.correlationMatrix);

  persistState();
}

function migrateState(state) {
  if (state.stateVersion !== STATE_VERSION) {
    state.scans = [];
    state.mlScoreCache = {};
    state.vectorbtCache = {};
    state.aiDecisionCache = {};
    state.archiveStatsCache = {};
    state.serverPaperSnapshot = structuredCloneSafe(DEFAULT_STATE.serverPaperSnapshot);
    state.paperHealth = structuredCloneSafe(DEFAULT_STATE.paperHealth);
    state.timeframeSummary = structuredCloneSafe(DEFAULT_STATE.timeframeSummary);
    state.correlationMatrix = structuredCloneSafe(DEFAULT_STATE.correlationMatrix);
    state.stateVersion = STATE_VERSION;
  }

  if (!Array.isArray(state.watchlist)) {
    state.watchlist = [];
  }

  if (!state.watchlist.includes("BTCUSD")) {
    state.watchlist = state.watchlist.filter((pair) => isValidPair(pair));
  }

  state.paperEngine = {
    ...structuredCloneSafe(DEFAULT_STATE.paperEngine),
    ...(state.paperEngine || {})
  };

  state.ftmo = {
    ...structuredCloneSafe(DEFAULT_STATE.ftmo),
    ...(state.ftmo || {})
  };
}

function sanitizeState(state) {
  state.activeTab = ["dashboard", "paper"].includes(state.activeTab)
    ? state.activeTab
    : "dashboard";

  state.timeframe = normalizeTimeframe(state.timeframe) || "M15";

  state.selectedPair = normalizePair(state.selectedPair) || "EURUSD";

  state.scans = Array.isArray(state.scans) ? state.scans : [];
  state.trades = Array.isArray(state.trades) ? state.trades : [];
  state.watchlist = Array.isArray(state.watchlist)
    ? [...new Set(state.watchlist.map(normalizePair).filter(Boolean))]
    : [];

  state.paperTrades = Array.isArray(state.paperTrades) ? state.paperTrades : [];
  state.paperArchive = Array.isArray(state.paperArchive) ? state.paperArchive : [];

  state.mlScoreCache = isPlainObject(state.mlScoreCache) ? state.mlScoreCache : {};
  state.vectorbtCache = isPlainObject(state.vectorbtCache) ? state.vectorbtCache : {};
  state.aiDecisionCache = isPlainObject(state.aiDecisionCache) ? state.aiDecisionCache : {};
  state.archiveStatsCache = isPlainObject(state.archiveStatsCache) ? state.archiveStatsCache : {};

  state.paperEngine.enabled = Boolean(state.paperEngine.enabled);
  state.paperEngine.autoRun = state.paperEngine.autoRun !== false;
  state.paperEngine.maxOpenTrades = clampNumber(state.paperEngine.maxOpenTrades, 1, 8, 4);
  state.paperEngine.minUltraScore = clampNumber(state.paperEngine.minUltraScore, 50, 95, 72);
  state.paperEngine.explorationScore = clampNumber(state.paperEngine.explorationScore, 45, 80, 58);
  state.paperEngine.riskPerTrade = clampNumber(state.paperEngine.riskPerTrade, 0.03, 1, 0.25);
  state.paperEngine.explorationRiskPerTrade = clampNumber(state.paperEngine.explorationRiskPerTrade, 0.03, 0.5, 0.1);
  state.paperEngine.maxBarsHold = clampNumber(state.paperEngine.maxBarsHold, 4, 40, 12);
  state.paperEngine.refreshIntervalMs = clampNumber(state.paperEngine.refreshIntervalMs, 10000, 120000, 20000);

  state.ftmo.accountSize = clampNumber(state.ftmo.accountSize, 100, 1000000, 10000);
  state.ftmo.requestedRiskPercent = clampNumber(state.ftmo.requestedRiskPercent, 0.01, 5, 1);
  state.ftmo.dailyLossLimitPercent = clampNumber(state.ftmo.dailyLossLimitPercent, 1, 20, 5);
  state.ftmo.maxLossLimitPercent = clampNumber(state.ftmo.maxLossLimitPercent, 1, 30, 10);
  state.ftmo.closedTodayPnl = safeNumber(state.ftmo.closedTodayPnl, 0);
  state.ftmo.totalClosedPnl = safeNumber(state.ftmo.totalClosedPnl, 0);

  if (!isPlainObject(state.timeframeSummary)) {
    state.timeframeSummary = structuredCloneSafe(DEFAULT_STATE.timeframeSummary);
  }

  if (!isPlainObject(state.correlationMatrix)) {
    state.correlationMatrix = structuredCloneSafe(DEFAULT_STATE.correlationMatrix);
  }

  if (!isPlainObject(state.serverPaperSnapshot)) {
    state.serverPaperSnapshot = structuredCloneSafe(DEFAULT_STATE.serverPaperSnapshot);
  }

  if (!isPlainObject(state.paperHealth)) {
    state.paperHealth = structuredCloneSafe(DEFAULT_STATE.paperHealth);
  }
}

function normalizePair(value) {
  const pair = String(value || "")
    .toUpperCase()
    .replace("/", "")
    .trim();

  return isValidPair(pair) ? pair : "";
}

function isValidPair(pair) {
  const symbols = PAIRS.map((item) => String(item.symbol || "").toUpperCase());
  return symbols.includes(String(pair || "").toUpperCase());
}

function normalizeTimeframe(value) {
  const timeframe = String(value || "")
    .toUpperCase()
    .trim();

  return ["M5", "M15", "H1", "H4"].includes(timeframe) ? timeframe : "";
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, n));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(target, source) {
  if (!isPlainObject(source)) return target;

  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      target[key] = deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }

  return target;
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
      }
