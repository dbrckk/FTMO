"use strict";

/*
FTMO EDGE AI - APP.JS (ENTRY FULL MODULAR VERSION)
Version propre, connectée à tous les modules
*/

import { PAIRS } from "./config.js";
import { appState, persistState, els } from "./state.js";

import { setupChart } from "./chart.js";

import {
  fetchCorrelationMatrix,
  refreshAiDecision
} from "./api.js";

import {
  scanPair,
  computeHedgeScore,
  isEliteTrade,
  computeConfluenceScore
} from "./scan.js";

import {
  renderOverview,
  renderPairList,
  renderTopPriorityTrades,
  renderTopBlockedTrades,
  renderCorrelationMatrix,
  renderSelectedPair,
  renderTrades,
  renderWatchlist,
  renderFtmoRisk
} from "./render.js";

import {
  onAddTrade,
  clearTrades,
  toggleCurrentWatchlist,
  exportTradesJson
} from "./trades.js";

/* ============================= */
/* INIT */
/* ============================= */

document.addEventListener("DOMContentLoaded", async () => {
  cacheEls();
  bindEvents();
  setupChart();
  await refreshAll(true);
});

/* ============================= */
/* CACHE DOM */
/* ============================= */

function cacheEls() {
  [
    "pairList",
    "tradeSuggestionBox",
    "exitSuggestionBox",
    "correlationSummary",
    "correlationMatrixBox",
    "chart",
    "summaryMetrics",
    "topPriorityTrades",
    "topBlockedTrades"
  ].forEach((id) => {
    els[id] = document.getElementById(id) || null;
  });
}

/* ============================= */
/* EVENTS */
/* ============================= */

function bindEvents() {

  document.getElementById("refreshBtn")?.addEventListener("click", () => {
    refreshAll(true);
  });

  document.getElementById("tradeForm")?.addEventListener("submit", (e) => {
    onAddTrade(e, renderTrades, renderFtmoRisk);
  });

  document.getElementById("clearTradesBtn")?.addEventListener("click", () => {
    clearTrades(renderTrades);
  });

  document.getElementById("watchlistBtn")?.addEventListener("click", () => {
    toggleCurrentWatchlist(renderWatchlist);
  });

  document.getElementById("exportBtn")?.addEventListener("click", () => {
    exportTradesJson();
  });

}

/* ============================= */
/* CORE ENGINE */
/* ============================= */

async function refreshAll(force = false) {

  try {

    /* ===== SCAN ===== */

    const scans = await Promise.all(
      PAIRS.map(pair => scanPair(pair))
    );

    /* ===== ENRICH ===== */

    appState.scans = scans
      .map(scan => {

        scan.hedgeScore = computeHedgeScore(scan);
        scan.elite = isEliteTrade(scan);
        scan.confluence = computeConfluenceScore(scan);

        return scan;

      })
      .sort((a, b) => {

        if ((b.confluence?.score || 0) !== (a.confluence?.score || 0)) {
          return (b.confluence?.score || 0) - (a.confluence?.score || 0);
        }

        return (b.finalScore || 0) - (a.finalScore || 0);

      });

    /* ===== SELECTED PAIR ===== */

    if (
      !appState.selectedPair ||
      !appState.scans.find(s => s.pair === appState.selectedPair)
    ) {
      appState.selectedPair = appState.scans[0]?.pair || "EURUSD";
    }

    /* ===== API CALLS ===== */

    await fetchCorrelationMatrix();
    await refreshAiDecision(force, renderSelectedPair);

    /* ===== RENDER ===== */

    renderOverview();

    renderPairList(refreshAiDecision);

    renderTopPriorityTrades();
    renderTopBlockedTrades();

    renderCorrelationMatrix();
    renderSelectedPair();

    renderTrades();
    renderWatchlist();
    renderFtmoRisk();

    /* ===== SAVE ===== */

    persistState();

  } catch (error) {

    console.error("❌ refreshAll failed", error);

  }
}

/* ============================= */
/* AUTO REFRESH (OPTIONNEL) */
/* ============================= */

let autoRefreshInterval = null;

export function startAutoRefresh(intervalMs = 30000) {

  stopAutoRefresh();

  autoRefreshInterval = setInterval(() => {
    refreshAll(false);
  }, intervalMs);

}

export function stopAutoRefresh() {

  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }

}

/* ============================= */
/* DEBUG TOOLS */
/* ============================= */

window.__APP__ = {
  state: appState,
  refresh: refreshAll,
  startAutoRefresh,
  stopAutoRefresh
};

/* ============================= */
/* SAFE GUARDS */
/* ============================= */

// Anti crash global
window.addEventListener("error", (e) => {
  console.error("GLOBAL ERROR:", e.error);
});

window.addEventListener("unhandledrejection", (e) => {
  console.error("PROMISE ERROR:", e.reason);
});

/* ============================= */
/* PERFORMANCE TRACK */
/* ============================= */

function measureExecution(name, fn) {
  const t0 = performance.now();
  const result = fn();
  const t1 = performance.now();
  console.log(`⚡ ${name}: ${(t1 - t0).toFixed(2)}ms`);
  return result;
}

/* ============================= */
/* FUTURE HOOKS */
/* ============================= */

// 🔥 ici tu peux brancher plus tard :

// - websocket prix live
// - vrai moteur ordre
// - gestion drawdown FTMO temps réel
// - alertes push
// - IA auto trading

/* ============================= */
/* END */
/* ============================= */
