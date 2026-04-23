import { PAIRS } from "./config.js";
import { appState, persistState, els } from "./state.js";
import { setupChart } from "./chart.js?v=2";
import { fetchCorrelationMatrix, refreshAiDecision } from "./api.js";
import { scanPair, computeHedgeScore, isEliteTrade, computeConfluenceScore } from "./scan.js";
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

function debugLine(text) {
  let box = document.getElementById("debugBox");
  if (!box) {
    box = document.createElement("div");
    box.id = "debugBox";
    box.style.position = "fixed";
    box.style.bottom = "10px";
    box.style.left = "10px";
    box.style.right = "10px";
    box.style.maxHeight = "40vh";
    box.style.overflow = "auto";
    box.style.zIndex = "99999";
    box.style.background = "rgba(0,0,0,0.92)";
    box.style.color = "#00ff88";
    box.style.padding = "10px";
    box.style.fontSize = "12px";
    box.style.border = "1px solid rgba(255,255,255,0.2)";
    box.style.borderRadius = "10px";
    document.body.appendChild(box);
  }

  const line = document.createElement("div");
  line.textContent = text;
  box.appendChild(line);
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    debugLine("1. DOMContentLoaded OK");
    cacheEls();
    debugLine("2. cacheEls OK");
    bindEvents();
    debugLine("3. bindEvents OK");
    setupChart();
    debugLine("4. setupChart OK");
    setActiveTab("dashboard");
    debugLine("5. setActiveTab OK");
    renderTabs();
    debugLine("6. renderTabs OK");
    await refreshAll(true);
    debugLine("7. refreshAll OK");
    startPaperLoop();
    debugLine("8. startPaperLoop OK");
  } catch (error) {
    debugLine("FATAL ERROR: " + (error?.message || error));
    console.error(error);
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
    "paperRecentTrades"
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

  document.getElementById("tabPaperBtn")?.addEventListener("click", () => {
    setActiveTab("paper");
    renderTabs();
    renderPaperLab();
  });

  document.getElementById("paperEngineToggleBtn")?.addEventListener("click", () => {
    appState.paperEngine.enabled = !appState.paperEngine.enabled;
    persistState();
    renderPaperLab();
  });
}

async function refreshAll(force = false) {
  try {
    debugLine("refreshAll: scan start");

    const scans = await Promise.all(PAIRS.map((pair) => scanPair(pair)));
    debugLine("refreshAll: scan done -> " + scans.length);

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
        if ((b.confluence?.score || 0) !== (a.confluence?.score || 0)) {
          return (b.confluence?.score || 0) - (a.confluence?.score || 0);
        }
        return (b.finalScore || 0) - (a.finalScore || 0);
      });

    debugLine("refreshAll: state scans set");

    if (!appState.selectedPair || !appState.scans.find((s) => s.pair === appState.selectedPair)) {
      appState.selectedPair = appState.scans[0]?.pair || "EURUSD";
    }

    debugLine("refreshAll: selected pair -> " + appState.selectedPair);

    await fetchCorrelationMatrix();
    debugLine("refreshAll: correlation OK");

    await refreshAiDecision(force, renderSelectedPair);
    debugLine("refreshAll: ai OK");

    runPaperEngine(appState.scans);
    debugLine("refreshAll: paper engine OK");

    renderOverview();
    debugLine("refreshAll: renderOverview OK");

    renderPairList(refreshAiDecision);
    debugLine("refreshAll: renderPairList OK");

    renderTopPriorityTrades();
    debugLine("refreshAll: renderTopPriorityTrades OK");

    renderTopBlockedTrades();
    debugLine("refreshAll: renderTopBlockedTrades OK");

    renderCorrelationMatrix();
    debugLine("refreshAll: renderCorrelationMatrix OK");

    renderSelectedPair();
    debugLine("refreshAll: renderSelectedPair OK");

    renderTrades();
    debugLine("refreshAll: renderTrades OK");

    renderWatchlist();
    debugLine("refreshAll: renderWatchlist OK");

    renderFtmoRisk();
    debugLine("refreshAll: renderFtmoRisk OK");

    renderPaperLab();
    debugLine("refreshAll: renderPaperLab OK");

    renderTabs();
    debugLine("refreshAll: renderTabs OK");

    persistState();
    debugLine("refreshAll: persist OK");
  } catch (error) {
    debugLine("refreshAll ERROR: " + (error?.message || error));
    console.error("refreshAll failed", error);
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
