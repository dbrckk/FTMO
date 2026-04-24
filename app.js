import { PAIRS } from "./config.js";
import { appState, persistState, els } from "./state.js";
import { setupChart } from "./chart.js";
import {
  fetchCorrelationMatrix,
  refreshAiDecision,
  fetchArchiveStatsBatch,
  fetchServerPaperSnapshot
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

    if (!appState.activeTab) {
      setActiveTab("dashboard");
    }

    renderTabs();
    renderTrades();
    renderWatchlist();
    renderPaperLab();
    renderFtmoRisk();

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
    "paperServerRuns"
  ].forEach((id) => {
    els[id] = document.getElementById(id) || null;
  });
}

function bindEvents() {
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
    await fetchServerPaperSnapshot();
    renderPaperLab();
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
    await Promise.allSettled([
      fetchArchiveStatsBatch(),
      fetchServerPaperSnapshot()
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
    await fetchServerPaperSnapshot();

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
    renderTabs();

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

window.__APP__ = {
  refreshAll,
  state: appState
};
