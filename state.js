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
      tradeArchive: Array.isArray(saved.tradeArchive) ? saved.tradeArchive : []
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
