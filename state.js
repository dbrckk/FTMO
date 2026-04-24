import { STORAGE_KEY } from "./config.js";

export const els = {};

export let chart = null;
export let candleSeries = null;

export const defaultState = {
  timeframe: "M15",
  selectedPair: "EURUSD",
  scans: [],
  trades: [],
  watchlist: [],
  activeTab: "dashboard",

  correlationMatrix: null,
  portfolioRiskData: null,

  mlScoreCache: {},
  vectorbtCache: {},
  aiDecisionCache: {},

  archiveStatsCache: {},
  archiveStatsUpdatedAt: null,

  serverPaperSnapshot: null,

  tradeArchive: [],
  paperTrades: [],
  paperArchive: [],

  ftmo: {
    accountSize: 10000,
    requestedRiskPercent: 1,
    dailyLossLimitPercent: 5,
    closedTodayPnl: 0
  },

  paperEngine: {
    enabled: true,
    autoRun: true,
    maxOpenTrades: 4,
    riskPerTrade: 0.25,
    minUltraScore: 72,
    explorationRiskPerTrade: 0.10,
    refreshIntervalMs: 20000,
    maxBarsHold: 12
  }
};

export let appState = loadState();

export function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

    if (!saved) {
      return structuredClone(defaultState);
    }

    return {
      ...structuredClone(defaultState),
      ...saved,

      scans: Array.isArray(saved.scans) ? saved.scans : [],
      trades: Array.isArray(saved.trades) ? saved.trades : [],
      watchlist: Array.isArray(saved.watchlist) ? saved.watchlist : [],

      tradeArchive: Array.isArray(saved.tradeArchive) ? saved.tradeArchive : [],
      paperTrades: Array.isArray(saved.paperTrades) ? saved.paperTrades : [],
      paperArchive: Array.isArray(saved.paperArchive) ? saved.paperArchive : [],

      mlScoreCache:
        saved.mlScoreCache && typeof saved.mlScoreCache === "object"
          ? saved.mlScoreCache
          : {},

      vectorbtCache:
        saved.vectorbtCache && typeof saved.vectorbtCache === "object"
          ? saved.vectorbtCache
          : {},

      aiDecisionCache:
        saved.aiDecisionCache && typeof saved.aiDecisionCache === "object"
          ? saved.aiDecisionCache
          : {},

      archiveStatsCache:
        saved.archiveStatsCache && typeof saved.archiveStatsCache === "object"
          ? saved.archiveStatsCache
          : {},

      serverPaperSnapshot:
        saved.serverPaperSnapshot && typeof saved.serverPaperSnapshot === "object"
          ? saved.serverPaperSnapshot
          : null,

      correlationMatrix:
        saved.correlationMatrix && typeof saved.correlationMatrix === "object"
          ? saved.correlationMatrix
          : null,

      portfolioRiskData:
        saved.portfolioRiskData && typeof saved.portfolioRiskData === "object"
          ? saved.portfolioRiskData
          : null,

      ftmo: {
        ...structuredClone(defaultState).ftmo,
        ...(saved.ftmo || {})
      },

      paperEngine: {
        ...structuredClone(defaultState).paperEngine,
        ...(saved.paperEngine || {})
      }
    };
  } catch {
    return structuredClone(defaultState);
  }
}

export function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  } catch {
    // Storage full or unavailable.
  }
}

export function resetState() {
  appState = structuredClone(defaultState);
  persistState();
}

export function setChartInstance(nextChart, nextCandleSeries) {
  chart = nextChart;
  candleSeries = nextCandleSeries;
      }
