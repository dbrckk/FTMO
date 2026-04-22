// ==========================
// state.js
// ==========================
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
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || structuredClone(defaultState);
  } catch {
    return structuredClone(defaultState);
  }
}

export function persistState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

export function setChartInstance(c, s) {
  chart = c;
  candleSeries = s;
}
