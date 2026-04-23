// state.js

import { STORAGE_KEY } from "./config.js";

export const els = {};

export let chart = null;
export let candleSeries = null;

export const defaultState = {
  timeframe: "M15",
  selectedPair: "EURUSD",
  scans: [],
  trades: [],
  tradeArchive: [],
  paperTrades: [],
  paperArchive: [],
  activeTab: "dashboard",
  watchlist: [],
  journal: null,
  mlScoreCache: {},
  aiDecisionCache: {},
  vectorbtCache: {},
  correlationMatrix: null,
  portfolioRiskData: null,
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
    refreshIntervalMs: 20000,
    maxBarsHold: 12
  }
};

export let appState = loadState();

export function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return structuredClone(defaultState);

    return {
      ...structuredClone(defaultState),
      ...saved,
      ftmo: {
        ...structuredClone(defaultState).ftmo,
        ...(saved.ftmo || {})
      },
      tradeArchive: Array.isArray(saved.tradeArchive) ? saved.tradeArchive : [],
      paperTrades: Array.isArray(saved.paperTrades) ? saved.paperTrades : [],
      paperArchive: Array.isArray(saved.paperArchive) ? saved.paperArchive : [],
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

export function setChartInstance(nextChart, nextCandleSeries) {
  chart = nextChart;
  candleSeries = nextCandleSeries;
    }
