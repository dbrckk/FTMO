import { PAIRS } from "./config.js";
import { appState, persistState, els } from "./state.js";
import { setupChart } from "./chart.js";
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
  renderFtmoRisk
} from "./render.js";
import {
  onAddTrade,
  clearTrades,
  toggleCurrentWatchlist,
  exportTradesJson
} from "./trades.js";

document.addEventListener("DOMContentLoaded", async () => {
  cacheEls();
  bindEvents();
  setupChart();
  await refreshAll(true);
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
    "ftmoDecisionBadge"
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
}

async function refreshAll(force = false) {
  try {
    const scans = await Promise.all(
      PAIRS.map((pair) => scanPair(pair))
    );

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

    if (
      !appState.selectedPair ||
      !appState.scans.find((s) => s.pair === appState.selectedPair)
    ) {
      appState.selectedPair = appState.scans[0]?.pair || "EURUSD";
    }

    await fetchCorrelationMatrix();
    await refreshAiDecision(force, renderSelectedPair);

    renderOverview();
    renderPairList(refreshAiDecision);
    renderTopPriorityTrades();
    renderTopBlockedTrades();
    renderCorrelationMatrix();
    renderSelectedPair();
    renderTrades();
    renderWatchlist();
    renderFtmoRisk();

    persistState();
  } catch (error) {
    console.error("refreshAll failed", error);
  }
}

window.__APP__ = {
  refreshAll,
  state: appState
};
