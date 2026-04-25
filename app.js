import { PAIRS } from "./config.js";
import { appState, persistState, els } from "./state.js";
import { setupChart } from "./chart.js";
import {
  fetchCorrelationMatrix,
  refreshAiDecision,
  fetchArchiveStatsBatch,
  fetchServerPaperSnapshot,
  fetchPaperHealth
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
  renderFtmoRisk,
  renderPaperLab,
  renderPaperHealth,
  renderTabs,
  setActiveTab
} from "./render.js";
import {
  onAddTrade,
  clearTrades,
  toggleCurrentWatchlist,
  exportTradesJson
} from "./trades.js";
import { runPaperEngine } from "./paper-engine.js";

let paperLoop = null;
let refreshInFlight = false;

document.addEventListener("DOMContentLoaded", async () => {
  try {
    cacheEls();
    bindEvents();
    setupChart();

    const timeframeSelect = document.getElementById("timeframeSelect");
    if (timeframeSelect) {
      timeframeSelect.value = appState.timeframe || "M15";
    }

    if (!appState.activeTab) {
      setActiveTab("dashboard");
    }

    renderTabs();
    renderTrades();
    renderWatchlist();
    renderPaperLab();
    renderPaperHealth();
    renderFtmoRisk();
    renderTimeframeLabel();

    await refreshAll(true);
    startPaperLoop();
  } catch (error) {
    console.error("App init failed", error);
  }
});

function cacheEls() {
  [
    "pairList",
    "tradeSuggestionBox",
    "exitSuggestionBox",
    "correlationSummary",
    "correlationMatrixBox",
    "chart",
    "chartTimeframeLabel",
    "summaryMetrics",
    "topPriorityTrades",
    "topBlockedTrades",
    "watchlist",
    "watchlistCount",
    "tradeList",
    "tradeStats",
    "selectedPairName",
    "trendMini",
    "confidenceMini",
    "rrMini",
    "aiMini",
    "decisionBadge",
    "decisionText",
    "decisionReason",
    "decisionAsset",
    "decisionConfidence",
    "decisionAction",
    "decisionWindow",
    "topPairLabel",
    "topPairReason",
    "bestScore",
    "allowedCount",
    "blockedCount",
    "globalExposure",
    "ftmoDailyRemaining",
    "ftmoMaxAdditionalRisk",
    "ftmoDecisionText",
    "ftmoDecisionReason",
    "ftmoDecisionBadge",
    "dashboardTab",
    "paperTab",
    "tabDashboardBtn",
    "tabPaperBtn",
    "paperEngineToggleBtn",
    "paperEngineStatus",
    "paperOpenTrades",
    "paperStats",
    "paperPairStats",
    "paperRecentTrades",
    "paperOpenKpi",
    "paperServerRuns",
    "paperHealthBox",
    "timeframeSelect"
  ].forEach((id) => {
    els[id] = document.getElementById(id) || null;
  });
}

function bindEvents() {
  document.getElementById("timeframeSelect")?.addEventListener("change", async (event) => {
    const nextTimeframe = String(event.target.value || "M15").toUpperCase();

    if (!["M5", "M15", "H1", "H4"].includes(nextTimeframe)) return;
    if (appState.timeframe === nextTimeframe) return;

    appState.timeframe = nextTimeframe;

    appState.scans = [];
    appState.mlScoreCache = {};
    appState.vectorbtCache = {};
    appState.aiDecisionCache = {};
    appState.archiveStatsCache = {};
    appState.serverPaperSnapshot = null;
    appState.paperHealth = null;

    persistState();

    renderTimeframeLabel();
    renderOverview();
    renderPairList(refreshAiDecision);
    renderPaperLab();
    renderPaperHealth();

    await refreshAll(true);
  });

  document.getElementById("refreshBtn")?.addEventListener("click", () => {
    refreshAll(true);
  });

  document.getElementById("tradeForm")?.addEventListener("submit", (e) => {
    onAddTrade(e, renderTrades, renderFtmoRisk);
  });

  document.getElementById("clearTradesBtn")?.addEventListener("click", () => {
    clearTrades(renderTrades);
    renderFtmoRisk();
  });

  document.getElementById("watchlistBtn")?.addEventListener("click", () => {
    toggleCurrentWatchlist(renderWatchlist);
  });

  document.getElementById("exportBtn")?.addEventListener("click", () => {
    exportTradesJson();
  });

  document.getElementById("tabDashboardBtn")?.addEventListener("click", () => {
    setActiveTab("dashboard");
    renderTabs();
  });

  document.getElementById("tabPaperBtn")?.addEventListener("click", async () => {
    setActiveTab("paper");
    renderTabs();

    await Promise.allSettled([
      fetchServerPaperSnapshot(),
      fetchPaperHealth()
    ]);

    renderPaperLab();
    renderPaperHealth();
  });

  document.getElementById("paperEngineToggleBtn")?.addEventListener("click", () => {
    appState.paperEngine.enabled = !appState.paperEngine.enabled;
    persistState();
    renderPaperLab();
  });
}

export async function refreshAll(force = false) {
  if (refreshInFlight) return;
  refreshInFlight = true;

  try {
    renderTimeframeLabel();

    await Promise.allSettled([
      fetchArchiveStatsBatch(),
      fetchServerPaperSnapshot(),
      fetchPaperHealth()
    ]);

    const scans = await Promise.all(PAIRS.map((pair) => scanPair(pair)));

    appState.scans = scans
      .map((scan) => {
        scan.hedgeScore = computeHedgeScore(scan);
        scan.elite = isEliteTrade(scan);
        scan.confluence = computeConfluenceScore(scan);
        return scan;
      })
      .sort((a, b) => {
        const aScore = Number(a.ultraScore || a.finalScore || 0);
        const bScore = Number(b.ultraScore || b.finalScore || 0);

        if (bScore !== aScore) return bScore - aScore;

        const bConf = Number(b.confluence?.score || 0);
        const aConf = Number(a.confluence?.score || 0);

        if (bConf !== aConf) return bConf - aConf;

        return Number(b.finalScore || 0) - Number(a.finalScore || 0);
      });

    if (
      !appState.selectedPair ||
      !appState.scans.find((scan) => scan.pair === appState.selectedPair)
    ) {
      appState.selectedPair = appState.scans[0]?.pair || "EURUSD";
    }

    await fetchCorrelationMatrix();
    await refreshAiDecision(force, renderSelectedPair);
    await runPaperEngine(appState.scans);

    await Promise.allSettled([
      fetchServerPaperSnapshot(),
      fetchPaperHealth()
    ]);

    renderOverview();
    renderPairList(refreshAiDecision);
    renderTopPriorityTrades();
    renderTopBlockedTrades();
    renderCorrelationMatrix();
    renderSelectedPair();
    renderTrades();
    renderWatchlist();
    renderFtmoRisk();
    renderPaperLab();
    renderPaperHealth();
    renderTabs();
    renderTimeframeLabel();

    persistState();
  } catch (error) {
    console.error("refreshAll failed", error);
  } finally {
    refreshInFlight = false;
  }
}

function startPaperLoop() {
  if (paperLoop) clearInterval(paperLoop);

  const intervalMs = Number(appState.paperEngine?.refreshIntervalMs || 20000);

  paperLoop = setInterval(() => {
    refreshAll(false);
  }, intervalMs);
}

function renderTimeframeLabel() {
  const label = document.getElementById("chartTimeframeLabel");
  if (!label) return;
  label.textContent = `${appState.timeframe || "M15"} primary candles`;
}

window.__APP__ = {
  refreshAll,
  state: appState
};
