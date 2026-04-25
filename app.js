import { PAIRS } from "./config.js";
import { appState, persistState, els } from "./state.js";
import { setupChart } from "./chart.js";
import {
  fetchCorrelationMatrix,
  refreshAiDecision,
  fetchArchiveStatsBatch,
  fetchServerPaperSnapshot,
  fetchPaperHealth,
  fetchTimeframeSummary
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
  renderTimeframeSummary,
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

const SCAN_TIMEOUT_MS = 15000;
const API_TIMEOUT_MS = 12000;
const SCAN_BATCH_SIZE = 3;

document.addEventListener("DOMContentLoaded", () => {
  try {
    cacheEls();
    bindEvents();
    setupChartSafe();

    const timeframeSelect = document.getElementById("timeframeSelect");
    if (timeframeSelect) {
      timeframeSelect.value = appState.timeframe || "M15";
    }

    if (!appState.activeTab) {
      setActiveTab("dashboard");
    }

    renderAllSafe();
    startPaperLoop();

    refreshAll(true);
  } catch (error) {
    showFatalError("App init failed", error);
  }
});

function setupChartSafe() {
  try {
    setupChart();
  } catch (error) {
    console.warn("Chart disabled, app continues", error);

    const chartBox = document.getElementById("chart");
    if (chartBox) {
      chartBox.innerHTML = `
        <div class="muted" style="padding:16px;">
          Chart temporarily unavailable. Scanner still running.
        </div>
      `;
    }
  }
}

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
    "timeframeSummaryBox",
    "timeframeSelect"
  ].forEach((id) => {
    els[id] = document.getElementById(id) || null;
  });
}

function bindEvents() {
  document.getElementById("timeframeSelect")?.addEventListener("change", (event) => {
    const nextTimeframe = String(event.target.value || "M15").toUpperCase();

    if (!["M5", "M15", "H1", "H4"].includes(nextTimeframe)) return;
    if (appState.timeframe === nextTimeframe) return;

    appState.timeframe = nextTimeframe;
    clearScanCaches();

    persistState();

    renderTimeframeLabel();
    renderLoadingState();

    refreshAll(true);
  });

  document.getElementById("refreshBtn")?.addEventListener("click", () => {
    refreshAll(true);
  });

  document.getElementById("tradeForm")?.addEventListener("submit", (event) => {
    onAddTrade(event, renderTrades, renderFtmoRisk);
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

  document.getElementById("tabPaperBtn")?.addEventListener("click", () => {
    setActiveTab("paper");
    renderTabs();

    renderPaperLab();
    renderPaperHealth();
    renderTimeframeSummary();

    refreshPaperData();
  });

  document.getElementById("paperEngineToggleBtn")?.addEventListener("click", () => {
    appState.paperEngine.enabled = !appState.paperEngine.enabled;
    persistState();
    renderPaperLab();
  });
}

export async function refreshAll(force = false) {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;

  try {
    renderTimeframeLabel();

    if (force) {
      appState.scans = [];
      renderLoadingState();
    }

    await refreshMetaData();

    const scanned = [];
    const pairEntries = PAIRS || [];

    for (let i = 0; i < pairEntries.length; i += SCAN_BATCH_SIZE) {
      const batch = pairEntries.slice(i, i + SCAN_BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map((pairEntry) => scanPairWithTimeout(pairEntry))
      );

      for (const result of results) {
        const scan = result.status === "fulfilled"
          ? result.value
          : buildFallbackScan("UNKNOWN", String(result.reason || "scan failed"));

        scanned.push(enrichScan(scan));
      }

      appState.scans = sortScans(scanned);

      if (
        !appState.selectedPair ||
        !appState.scans.find((scan) => scan.pair === appState.selectedPair)
      ) {
        appState.selectedPair = appState.scans[0]?.pair || "EURUSD";
      }

      renderDashboardAfterScan();
      persistState();

      await sleep(40);
    }

    await refreshPostScanData(force);

    renderDashboardAfterScan();
    renderPaperLab();
    renderPaperHealth();
    renderTimeframeSummary();
    renderTabs();
    renderTimeframeLabel();

    persistState();
  } catch (error) {
    console.error("refreshAll failed", error);
    showPairListError("Refresh error", error);
  } finally {
    refreshInFlight = false;
  }
}

async function refreshMetaData() {
  await Promise.allSettled([
    withTimeout(fetchArchiveStatsBatch(), API_TIMEOUT_MS, null),
    withTimeout(fetchServerPaperSnapshot(), API_TIMEOUT_MS, null),
    withTimeout(fetchPaperHealth(), API_TIMEOUT_MS, null),
    withTimeout(fetchTimeframeSummary(), API_TIMEOUT_MS, null)
  ]);

  renderPaperLab();
  renderPaperHealth();
  renderTimeframeSummary();
}

async function refreshPostScanData(force) {
  await Promise.allSettled([
    withTimeout(fetchCorrelationMatrix(), API_TIMEOUT_MS, null),
    withTimeout(refreshAiDecision(force, renderSelectedPair), API_TIMEOUT_MS, null)
  ]);

  const mtfProtectedScans = applyBrowserPaperMtfGuard(appState.scans);

  await withTimeout(
    runPaperEngine(mtfProtectedScans),
    API_TIMEOUT_MS,
    null
  );

  await Promise.allSettled([
    withTimeout(fetchServerPaperSnapshot(), API_TIMEOUT_MS, null),
    withTimeout(fetchPaperHealth(), API_TIMEOUT_MS, null),
    withTimeout(fetchTimeframeSummary(), API_TIMEOUT_MS, null)
  ]);
}

async function refreshPaperData() {
  await Promise.allSettled([
    withTimeout(fetchServerPaperSnapshot(), API_TIMEOUT_MS, null),
    withTimeout(fetchPaperHealth(), API_TIMEOUT_MS, null),
    withTimeout(fetchTimeframeSummary(), API_TIMEOUT_MS, null)
  ]);

  renderPaperLab();
  renderPaperHealth();
  renderTimeframeSummary();
}

async function scanPairWithTimeout(pairEntry) {
  const symbol = getPairSymbol(pairEntry);

  try {
    return await withTimeout(
      scanPair(pairEntry),
      SCAN_TIMEOUT_MS,
      buildFallbackScan(symbol, "Scan timeout")
    );
  } catch (error) {
    return buildFallbackScan(symbol, String(error?.message || error || "scan error"));
  }
}

function enrichScan(scan) {
  const safeScan = scan || buildFallbackScan("UNKNOWN", "Invalid scan");

  safeScan.hedgeScore = computeHedgeScore(safeScan);
  safeScan.elite = isEliteTrade(safeScan);
  safeScan.confluence = computeConfluenceScore(safeScan);

  return safeScan;
}

function sortScans(scans) {
  return [...(scans || [])].sort((a, b) => {
    const aScore = Number(a.ultraScore || a.finalScore || 0);
    const bScore = Number(b.ultraScore || b.finalScore || 0);

    if (bScore !== aScore) return bScore - aScore;

    const bConf = Number(b.confluence?.score || 0);
    const aConf = Number(a.confluence?.score || 0);

    if (bConf !== aConf) return bConf - aConf;

    return Number(b.finalScore || 0) - Number(a.finalScore || 0);
  });
}

function renderDashboardAfterScan() {
  renderOverview();
  renderPairList(refreshAiDecision);
  renderTopPriorityTrades();
  renderTopBlockedTrades();
  renderCorrelationMatrix();
  renderSelectedPair();
  renderTrades();
  renderWatchlist();
  renderFtmoRisk();
}

function renderAllSafe() {
  renderTabs();
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
  renderTimeframeSummary();
  renderTimeframeLabel();
}

function renderLoadingState() {
  setTextSafe("topPairLabel", "-");
  setTextSafe("topPairReason", "Scanning...");
  setTextSafe("bestScore", "-");
  setTextSafe("allowedCount", "0");
  setTextSafe("blockedCount", "0");

  if (els.pairList) {
    els.pairList.innerHTML = `
      <div class="muted" style="padding:14px;">
        Scanning ${PAIRS.length} assets...
      </div>
    `;
  }
}

function applyBrowserPaperMtfGuard(scans) {
  return (scans || []).map((scan) => {
    const mtf = getMtfForPair(scan.pair);

    if (!mtf) {
      return {
        ...scan,
        tradeAllowed: false,
        tradeStatus: "BLOCKED MTF",
        tradeReason: "No multi-timeframe alignment available."
      };
    }

    const scanSignal = String(scan.signal || "").toUpperCase();
    const mtfSignal = String(mtf.signal || "").toUpperCase();
    const mtfScore = Number(mtf.score || 0);

    const opposite =
      (scanSignal === "BUY" && mtfSignal === "SELL") ||
      (scanSignal === "SELL" && mtfSignal === "BUY");

    if (opposite) {
      return {
        ...scan,
        tradeAllowed: false,
        tradeStatus: "BLOCKED MTF",
        tradeReason: `MTF opposite direction: ${mtfSignal}.`
      };
    }

    if (mtfScore < 60) {
      return {
        ...scan,
        tradeAllowed: false,
        tradeStatus: "BLOCKED MTF",
        tradeReason: `MTF score too weak: ${Math.round(mtfScore)}/100.`
      };
    }

    if (mtfScore < 68 && Number(scan.ultraScore || 0) < 82) {
      return {
        ...scan,
        tradeAllowed: false,
        tradeStatus: "BLOCKED MTF",
        tradeReason: `MTF not strong enough for browser paper: ${Math.round(mtfScore)}/100.`
      };
    }

    return {
      ...scan,
      mtfScore,
      mtfSignal,
      mtfLabel: mtf.label || "MTF alignment"
    };
  });
}

function getMtfForPair(pair) {
  const mtf = appState.timeframeSummary?.mtfAlignment;
  const topPairs = Array.isArray(mtf?.topPairs) ? mtf.topPairs : [];

  return topPairs.find((item) => item.pair === pair) || null;
}

function startPaperLoop() {
  if (paperLoop) clearInterval(paperLoop);

  const intervalMs = Number(appState.paperEngine?.refreshIntervalMs || 20000);

  paperLoop = setInterval(() => {
    if (!refreshInFlight) {
      refreshAll(false);
    }
  }, intervalMs);
}

function renderTimeframeLabel() {
  const label = document.getElementById("chartTimeframeLabel");
  if (!label) return;

  label.textContent = `${appState.timeframe || "M15"} primary candles`;
}

function clearScanCaches() {
  appState.scans = [];
  appState.mlScoreCache = {};
  appState.vectorbtCache = {};
  appState.aiDecisionCache = {};
  appState.archiveStatsCache = {};
  appState.serverPaperSnapshot = null;
  appState.paperHealth = null;
  appState.timeframeSummary = {
    ok: false,
    mtfAlignment: {
      best: null,
      topPairs: []
    },
    summary: {}
  };
}

function buildFallbackScan(pair, reason) {
  const symbol = String(pair || "UNKNOWN").toUpperCase();

  return {
    pair: symbol,
    timeframe: appState.timeframe || "M15",
    candles: [],
    current: 0,
    direction: "wait",
    signal: "WAIT",
    finalScore: 0,
    ultraScore: 0,
    ultraGrade: "NO DATA",
    localScore: 0,
    mlScore: 0,
    vectorbtScore: 0,
    trendScore: 0,
    timingScore: 0,
    riskScore: 0,
    contextScore: 0,
    smartMoneyScore: 0,
    sessionScore: 0,
    executionScore: 0,
    archiveEdgeScore: 50,
    archiveStats: null,
    archiveConfidence: 0,
    rsi14: 50,
    macdLine: 0,
    atr14: 0,
    momentum: 0,
    rr: 0,
    stopLoss: 0,
    takeProfit: 0,
    tradeAllowed: false,
    tradeStatus: "NO DATA",
    tradeReason: reason,
    reason,
    reasons: [reason]
  };
}

function getPairSymbol(pairEntry) {
  if (typeof pairEntry === "string") {
    return pairEntry.toUpperCase();
  }

  return String(pairEntry?.symbol || "UNKNOWN").toUpperCase();
}

function withTimeout(promise, timeoutMs, fallbackValue) {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallbackValue);
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallbackValue);
      });
  });
}

function showFatalError(label, error) {
  console.error(label, error);
  showPairListError(label, error);
}

function showPairListError(label, error) {
  const pairList = document.getElementById("pairList");
  if (!pairList) return;

  pairList.innerHTML = `
    <div class="bad" style="padding:14px;">
      ${escapeHtml(label)}: ${escapeHtml(String(error?.message || error))}
    </div>
  `;
}

function setTextSafe(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

window.__APP__ = {
  refreshAll,
  state: appState
};
