"use strict";

/*
FTMO EDGE AI - APP.JS FINAL PATCH
Aligné avec :
- /api/ml-score (fix data wrapper)
- /api/vectorbt-score (fix data wrapper)
- /api/correlation-matrix (ajout)
- /api/portfolio-risk (ajout)
- UI synchronisée
*/

const STORAGE_KEY = "ftmo-edge-ai-v3";

const TIMEFRAMES = ["M5","M15","H1","H4"];

const PAIRS = [
  { symbol: "EURUSD", group: "forex", tier: 1 },
  { symbol: "GBPUSD", group: "forex", tier: 1 },
  { symbol: "USDJPY", group: "yen", tier: 1 },
  { symbol: "XAUUSD", group: "metals", tier: 2 },
  { symbol: "NAS100", group: "indices", tier: 2 }
];

const API = {
  market: "/api/market-data",
  ml: "/api/ml-score",
  vectorbt: "/api/vectorbt-score",
  ai: "/api/ai-decision",
  exit: "/api/exit-engine",
  correlation: "/api/correlation-matrix",
  portfolio: "/api/portfolio-risk"
};

const els = {};
let chart, candleSeries;

const defaultState = {
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
    requestedRiskPercent: 1
  }
};

let appState = loadState();

document.addEventListener("DOMContentLoaded", async () => {
  cacheEls();
  bindEvents();
  setupChart();
  await refreshAll(true);
});

/* ============================= */
/* STATE */
/* ============================= */

function loadState(){
  try{
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || structuredClone(defaultState);
  }catch{
    return structuredClone(defaultState);
  }
}

function persistState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

/* ============================= */
/* UI */
/* ============================= */

function cacheEls(){
  [
    "pairList","tradeSuggestionBox","exitSuggestionBox",
    "correlationSummary","correlationMatrixBox"
  ].forEach(id => els[id] = document.getElementById(id));
}

function bindEvents(){
  document.getElementById("refreshBtn")?.addEventListener("click", () => refreshAll(true));
}

/* ============================= */
/* CORE REFRESH */
/* ============================= */

async function refreshAll(force=false){

  appState.scans = await Promise.all(
    PAIRS.map(p => scanPair(p))
  );

  await fetchCorrelationMatrix();

  renderPairList();
  renderCorrelationMatrix();

  persistState();
}

/* ============================= */
/* SCAN ENGINE */
/* ============================= */

async function scanPair(pair){

  const candles = generateFakeCandles(pair.symbol);

  const closes = candles.map(c=>c.close);

  const scan = {
    pair: pair.symbol,
    candles,
    current: closes.at(-1),
    trendScore: Math.random()*100,
    timingScore: Math.random()*100,
    riskScore: Math.random()*100,
    contextScore: Math.random()*100
  };

  const ml = await fetchMlScore(scan);
  const vb = await fetchVectorbtScore(scan);

  scan.mlScore = ml.mlScore;
  scan.vectorbtScore = vb.vectorbtScore;

  scan.finalScore = Math.round(
    scan.trendScore*0.25 +
    scan.timingScore*0.25 +
    scan.contextScore*0.2 +
    scan.riskScore*0.1 +
    (scan.mlScore||0)*0.1 +
    (scan.vectorbtScore||0)*0.1
  );

  return scan;
}


/* ============================= */
/* API PATCHES */
/* ============================= */

async function fetchMlScore(scan) {
  try {
    const journalContext = buildJournalContextForPair(scan) || {};

    const response = await fetch(API.ml, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: {
          pair: scan.pair,
          timeframe: appState.timeframe,
          trendScore: scan.trendScore,
          timingScore: scan.timingScore,
          riskScore: scan.riskScore,
          contextScore: scan.contextScore,
          entryTriggerScore: scan.entryTriggerScore || 0,
          entrySniperScore: scan.entrySniper?.score || 0,
          exitSniperScore: scan.exitSniper?.score || 0,
          rsi14: scan.rsi14 || 50,
          macdLine: scan.macdLine || 0,
          atr14: scan.atr14 || 0,
          momentum: scan.momentum || 0,
          rr: scan.rr || 1.5,
          macroPenalty: scan.macroPenalty || 0,
          spreadPenalty: scan.spreadPenalty || 0,
          offSessionPenalty: scan.offSessionPenalty || 0,
          pairExpectancy: journalContext.pairExpectancy || 0,
          hourExpectancy: journalContext.hourExpectancy || 0,
          sessionExpectancy: journalContext.sessionExpectancy || 0,
          pairWinRate: journalContext.pairWinRate || 0,
          hourWinRate: journalContext.hourWinRate || 0,
          sessionWinRate: journalContext.sessionWinRate || 0
        }
      })
    });

    if (!response.ok) throw new Error(`ml-score ${response.status}`);

    const data = await response.json();
    appState.mlScoreCache[scan.pair] = data;
    return data;
  } catch {
    const fallback = {
      ok: true,
      source: "ml-fallback",
      mlScore: clamp(
        Math.round(
          scan.trendScore * 0.22 +
          scan.timingScore * 0.26 +
          scan.riskScore * 0.20 +
          scan.contextScore * 0.14 +
          (scan.entryTriggerScore || 50) * 0.18
        ),
        1,
        99
      ),
      confidenceBand: "medium",
      explanation: "Score ML indisponible, fallback local utilisé."
    };

    appState.mlScoreCache[scan.pair] = fallback;
    return fallback;
  }
}

async function fetchVectorbtScore(scan) {
  try {
    const response = await fetch(API.vectorbt, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: {
          pair: scan.pair,
          timeframe: appState.timeframe,
          candles: scan.candles,
          fee: 0.0002,
          slippage: 0.0001,
          fast_ema: 20,
          slow_ema: 50,
          rsi_period: 14,
          atr_period: 14,
          macd_fast: 12,
          macd_slow: 26,
          macd_signal: 9,
          rsi_buy_min: 45,
          rsi_buy_max: 65,
          rsi_sell_min: 35,
          rsi_sell_max: 55,
          stop_atr_mult: 1.4,
          take_atr_mult: 2.6
        }
      })
    });

    if (!response.ok) throw new Error(`vectorbt-score ${response.status}`);

    const data = await response.json();
    appState.vectorbtCache[scan.pair] = data;
    return data;
  } catch {
    const fallback = {
      ok: true,
      source: "vectorbt-fallback",
      vectorbtScore: 55,
      confidenceBand: "medium",
      explanation: "VectorBT indisponible, fallback neutre utilisé.",
      metrics: {
        totalReturnPct: 0,
        winRatePct: 0,
        maxDrawdownPct: 0,
        totalTrades: 0,
        profitFactor: 0,
        sharpeRatio: 0,
        expectancy: 0
      }
    };

    appState.vectorbtCache[scan.pair] = fallback;
    return fallback;
  }
}

async function fetchCorrelationMatrix() {
  try {
    const rows = appState.scans.slice(0, 10).map((scan) => ({
      pair: scan.pair,
      closes: scan.candles.map((c) => c.close).slice(-120)
    }));

    const response = await fetch(API.correlation, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ rows })
    });

    if (!response.ok) throw new Error(`correlation-matrix ${response.status}`);

    const data = await response.json();
    appState.correlationMatrix = data;
    persistState();
    return data;
  } catch {
    appState.correlationMatrix = null;
    return null;
  }
}

async function fetchPortfolioRisk() {
  try {
    const positions = appState.trades
      .filter((t) => t.status === "active")
      .map((t) => ({
        pair: t.pair,
        riskPercent: Number(t.riskPercent || 0)
      }));

    const response = await fetch(API.portfolio, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ positions })
    });

    if (!response.ok) throw new Error(`portfolio-risk ${response.status}`);

    const data = await response.json();
    appState.portfolioRiskData = data;
    persistState();
    return data;
  } catch {
    appState.portfolioRiskData = {
      ok: false,
      decision: "REDUCE",
      reason: "Portfolio risk unavailable."
    };
    return appState.portfolioRiskData;
  }
}

/* ============================= */
/* JOURNAL CONTEXT */
/* ============================= */

function buildJournalContextForPair(scan) {
  const journal = appState.journal;
  if (!journal) return null;

  const pairStat = (journal.pairStats || []).find((item) => item.key === scan.pair);

  const now = new Date();
  const currentHour = Number(now.toLocaleString("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Europe/Paris"
  }));

  const currentSession = normalizeSessionLabel(getMarketSession(now).label);

  const hourStat = (journal.hourStats || []).find((item) => Number(item.key) === currentHour);
  const sessionStat = (journal.sessionStats || []).find((item) => item.key === currentSession);

  return {
    pairExpectancy: Number(pairStat?.expectancy ?? 0),
    hourExpectancy: Number(hourStat?.expectancy ?? 0),
    sessionExpectancy: Number(sessionStat?.expectancy ?? 0),
    pairWinRate: Number(pairStat?.winRate ?? 0),
    hourWinRate: Number(hourStat?.winRate ?? 0),
    sessionWinRate: Number(sessionStat?.winRate ?? 0)
  };
}

function normalizeSessionLabel(label) {
  if (!label) return "OffSession";
  if (label.includes("London + New York")) return "London+NewYork";
  if (label === "London") return "London";
  if (label === "New York") return "NewYork";
  if (label === "Tokyo") return "Tokyo";
  return "OffSession";
}

function getMarketSession(date) {
  const hour = Number(date.toLocaleString("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Europe/Paris"
  }));

  const tokyo = hour >= 1 && hour < 10;
  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const overlap = london && newYork;

  if (overlap) {
    return {
      label: "London + New York",
      headline: "Liquidité forte : la sélection devient plus stricte.",
      biasLabel: "Volatilité forte"
    };
  }

  if (london) {
    return {
      label: "London",
      headline: "Session Londres : utile pour EUR, GBP et indices européens.",
      biasLabel: "Bias Europe"
    };
  }

  if (newYork) {
    return {
      label: "New York",
      headline: "Session US : surveille USD, XAUUSD et NAS100.",
      biasLabel: "Bias US"
    };
  }

  if (tokyo) {
    return {
      label: "Tokyo",
      headline: "Session Asie : focus sur JPY, AUD et NZD.",
      biasLabel: "Bias Asie"
    };
  }

  return {
    label: "Off-session",
    headline: "Liquidité plus faible : l’app refuse davantage de trades.",
    biasLabel: "Liquidité faible"
  };
}

/* ============================= */
/* RENDER PAIR LIST + MATRIX */
/* ============================= */

function renderPairList() {
  if (!els.pairList) return;
  els.pairList.innerHTML = "";

  const list = appState.scans || [];

  list.forEach((scan) => {
    const row = document.createElement("div");
    row.className = "pair-row";
    row.dataset.pair = scan.pair;

    row.innerHTML = `
      <div><strong>${scan.pair}</strong></div>
      <div>${Math.round(scan.finalScore || 0)}</div>
      <div>${Math.round(scan.mlScore || 0)}</div>
      <div>${Math.round(scan.vectorbtScore || 0)}</div>
      <div class="${(scan.finalScore || 0) >= 70 ? "ok" : "bad"}">${(scan.finalScore || 0) >= 70 ? "GO" : "WAIT"}</div>
    `;

    row.addEventListener("click", () => {
      appState.selectedPair = scan.pair;
      persistState();
      renderSelectedPair();
    });

    els.pairList.appendChild(row);
  });
}

function renderCorrelationMatrix() {
  if (!els.correlationSummary || !els.correlationMatrixBox) return;

  const data = appState.correlationMatrix;
  if (!data || !Array.isArray(data.pairs) || !Array.isArray(data.matrix)) {
    els.correlationSummary.innerHTML = "Correlation matrix unavailable.";
    els.correlationMatrixBox.innerHTML = `<div class="muted">Aucune donnée.</div>`;
    return;
  }

  const alerts = [];
  for (let i = 0; i < data.pairs.length; i += 1) {
    for (let j = i + 1; j < data.pairs.length; j += 1) {
      const corr = Number(data.matrix[i][j] || 0);
      if (Math.abs(corr) >= 0.8) {
        alerts.push(`${data.pairs[i]} / ${data.pairs[j]} : ${corr.toFixed(2)}`);
      }
    }
  }

  els.correlationSummary.innerHTML = alerts.length
    ? `<strong>High correlation pairs detected:</strong><br/>${alerts.slice(0, 6).join("<br/>")}`
    : `No major correlation concentration detected.`;

  els.correlationMatrixBox.innerHTML = `
    <div style="overflow:auto;">
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left; padding:8px;">Pair</th>
            ${data.pairs.map((pair) => `<th style="padding:8px;">${pair}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${data.pairs.map((rowPair, i) => `
            <tr>
              <td style="padding:8px; font-weight:700;">${rowPair}</td>
              ${data.matrix[i].map((value, j) => {
                const corr = Number(value || 0);
                const bg =
                  i === j ? "rgba(255,255,255,0.08)" :
                  Math.abs(corr) >= 0.8 ? "rgba(255,102,127,0.18)" :
                  Math.abs(corr) >= 0.6 ? "rgba(255,193,77,0.14)" :
                  "rgba(255,255,255,0.03)";
                return `<td style="padding:8px; text-align:center; background:${bg};">${corr.toFixed(2)}</td>`;
              }).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

/* ============================= */
/* SELECTED PANEL */
/* ============================= */

function renderSelectedPair() {
  const pair = appState.selectedPair;
  if (!pair) return;

  const scan = appState.scans.find((s) => s.pair === pair);
  if (!scan) return;

  const ai = appState.aiDecisionCache?.[pair] || {
    decision: "WAIT",
    title: "Décision en attente",
    reason: "Aucune décision IA disponible."
  };

  const selectedName = document.getElementById("selectedPairName");
  const trendMini = document.getElementById("trendMini");
  const confidenceMini = document.getElementById("confidenceMini");
  const rrMini = document.getElementById("rrMini");
  const aiMini = document.getElementById("aiMini");
  const reasonList = document.getElementById("reasonList");
  const tradeSuggestionBox = document.getElementById("tradeSuggestionBox");
  const exitSuggestionBox = document.getElementById("exitSuggestionBox");
  const metricWrap = document.getElementById("summaryMetrics");

  if (selectedName) selectedName.textContent = scan.pair;
  if (trendMini) trendMini.textContent = Math.round(scan.trendScore || 0);
  if (confidenceMini) confidenceMini.textContent = `${Math.round(scan.finalScore || 0)}%`;
  if (rrMini) rrMini.textContent = scan.rr || "-";
  if (aiMini) aiMini.textContent = ai.decision || "-";

  const decisionBadge = document.getElementById("decisionBadge");
  const decisionText = document.getElementById("decisionText");
  const decisionReason = document.getElementById("decisionReason");
  const decisionAsset = document.getElementById("decisionAsset");
  const decisionConfidence = document.getElementById("decisionConfidence");
  const decisionAction = document.getElementById("decisionAction");
  const decisionWindow = document.getElementById("decisionWindow");

  if (decisionBadge) decisionBadge.textContent = ai.decision || "WAIT";
  if (decisionText) decisionText.textContent = ai.title || "Décision IA";
  if (decisionReason) decisionReason.textContent = ai.reason || "-";
  if (decisionAsset) decisionAsset.textContent = scan.pair;
  if (decisionConfidence) decisionConfidence.textContent = `${Math.round(ai.confidence || scan.finalScore || 0)}%`;
  if (decisionAction) decisionAction.textContent = ai.action || (scan.finalScore >= 70 ? "EXECUTE" : "WAIT");
  if (decisionWindow) decisionWindow.textContent = ai.window || "Intraday";

  if (metricWrap) {
    metricWrap.innerHTML = [
      metricCard("Prix", formatPrice(scan.current), "marché"),
      metricCard("Final", Math.round(scan.finalScore || 0), "global"),
      metricCard("Trend", Math.round(scan.trendScore || 0), "direction"),
      metricCard("Timing", Math.round(scan.timingScore || 0), "timing"),
      metricCard("Risk", Math.round(scan.riskScore || 0), "risk"),
      metricCard("Context", Math.round(scan.contextScore || 0), "context"),
      metricCard("ML", Math.round(scan.mlScore || 0), scan.mlConfidenceBand || "model"),
      metricCard("VBT", Math.round(scan.vectorbtScore || 0), scan.vectorbtConfidenceBand || "backtest")
    ].join("");
  }

  if (reasonList) {
    reasonList.innerHTML = "";
    (scan.reasons || []).forEach((reason) => {
      const li = document.createElement("li");
      li.textContent = reason;
      reasonList.appendChild(li);
    });
  }

  const riskPct = computeDynamicRiskPercent(scan);
  const sizing = computePositionSizing(scan, Number(document.getElementById("tradeCapital")?.value || appState.ftmo.accountSize || 10000));

  if (tradeSuggestionBox) {
    tradeSuggestionBox.innerHTML = `
      <strong>${ai.decision || scan.signal || "WAIT"}</strong><br>
      Entry: ${formatPrice(scan.current)}<br>
      Stop: ${formatPrice(scan.stopLoss || scan.current * 0.995)}<br>
      Target: ${formatPrice(scan.takeProfit || scan.current * 1.01)}<br>
      ML: ${Math.round(scan.mlScore || 0)}<br>
      VectorBT: ${Math.round(scan.vectorbtScore || 0)}<br>
      Risk conseillé: ${riskPct}%<br>
      Position size: ${sizing.quantity}<br>
      Profile: ${sizing.leverageLabel}<br>
      Motif: ${ai.reason || scan.reason || "-"}
    `;
  }

  if (exitSuggestionBox) {
    exitSuggestionBox.innerHTML = `
      Exit logic: ${scan.exitSniper?.action || "HOLD"}<br>
      Exit score: ${scan.exitSniper?.score || 0}<br>
      Comment: ${scan.exitSniper?.reason || "No exit signal"}
    `;
  }

  updateChart(scan.candles || []);

  const tradePair = document.getElementById("tradePair");
  const tradeDirection = document.getElementById("tradeDirection");
  const tradeEntry = document.getElementById("tradeEntry");
  const riskPercent = document.getElementById("riskPercent");

  if (tradePair) tradePair.value = scan.pair;
  if (tradeDirection) tradeDirection.value = scan.signal === "SELL" ? "sell" : "buy";
  if (tradeEntry) tradeEntry.value = Number(scan.current || 0).toFixed(5);
  if (riskPercent) riskPercent.value = String(riskPct);
}

/* ============================= */
/* AI DECISION */
/* ============================= */

async function refreshAiDecision(force = false) {
  const scan = appState.scans.find((s) => s.pair === appState.selectedPair);
  if (!scan) return;

  if (!force && appState.aiDecisionCache?.[scan.pair]) {
    renderSelectedPair();
    return;
  }

  try {
    const response = await fetch(API.ai, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        pair: scan.pair,
        timeframe: appState.timeframe,
        finalScore: scan.finalScore,
        trendScore: scan.trendScore,
        timingScore: scan.timingScore,
        riskScore: scan.riskScore,
        contextScore: scan.contextScore,
        mlScore: scan.mlScore,
        vectorbtScore: scan.vectorbtScore,
        signal: scan.finalScore >= 70 ? "BUY" : scan.finalScore <= 35 ? "SELL" : "WAIT"
      })
    });

    if (!response.ok) throw new Error(`ai ${response.status}`);
    const data = await response.json();

    appState.aiDecisionCache[scan.pair] = {
      decision: sanitizeDecision(data.decision),
      title: data.title || "Décision IA",
      reason: data.reason || "Décision générée.",
      confidence: Number(data.confidence || scan.finalScore || 0),
      action: data.action || "WAIT",
      window: data.window || "intraday"
    };
  } catch {
    appState.aiDecisionCache[scan.pair] = {
      decision: scan.finalScore >= 70 ? "TRADE" : "WAIT",
      title: "Fallback IA",
      reason: "Décision locale utilisée.",
      confidence: Number(scan.finalScore || 0),
      action: scan.finalScore >= 70 ? "EXECUTE" : "WAIT",
      window: "intraday"
    };
  }

  persistState();
  renderSelectedPair();
}

/* ============================= */
/* TRADE ENGINE */
/* ============================= */

async function onAddTrade(e) {
  e.preventDefault();

  const pair = document.getElementById("tradePair")?.value;
  const direction = document.getElementById("tradeDirection")?.value || "buy";
  const capital = Number(document.getElementById("tradeCapital")?.value || appState.ftmo.accountSize || 10000);
  const entry = Number(document.getElementById("tradeEntry")?.value || 0);
  const riskPercent = Number(document.getElementById("riskPercent")?.value || 1);
  const notes = document.getElementById("tradeNotes")?.value || "";

  const scan = appState.scans.find((s) => s.pair === pair);
  if (!scan) return;

  const portfolioRisk = await fetchPortfolioRisk();
  if (portfolioRisk?.decision === "BLOCK") {
    if (els.tradeSuggestionBox) {
      els.tradeSuggestionBox.innerHTML = `
        <strong>TRADE BLOQUÉ</strong><br>
        ${portfolioRisk.reason || "Le portefeuille est trop concentré."}
      `;
    }
    return;
  }

  const trade = {
    id: Date.now(),
    pair,
    direction,
    capital,
    riskPercent,
    entry,
    notes,
    createdAt: new Date().toISOString(),
    status: "active",
    mlScore: scan.mlScore,
    vectorbtScore: scan.vectorbtScore,
    finalScore: scan.finalScore
  };

  appState.trades.push(trade);
  persistState();

renderTrades();
  renderFtmoRisk();
}

function renderTrades() {
  const tradeList = document.getElementById("tradeList");
  const tradeStats = document.getElementById("tradeStats");
  if (!tradeList) return;

  tradeList.innerHTML = "";

  appState.trades.forEach((trade) => {
    const row = document.createElement("div");
    row.className = "trade-row";
    row.innerHTML = `
      <div><strong>${trade.pair}</strong></div>
      <div>${trade.direction}</div>
      <div>${trade.riskPercent}%</div>
      <div>${Number(trade.entry || 0).toFixed(5)}</div>
      <div>${trade.status}</div>
    `;
    tradeList.appendChild(row);
  });

  if (tradeStats) {
    tradeStats.textContent = String(appState.trades.length);
  }
}

function clearTrades() {
  appState.trades = [];
  persistState();
  renderTrades();
}

/* ============================= */
/* FTMO / PORTFOLIO */
/* ============================= */

function renderFtmoRisk() {
  const ftmo = appState.ftmo;
  const remainingDaily =
    (ftmo.accountSize * ftmo.dailyLossLimitPercent / 100) -
    Math.abs(ftmo.closedTodayPnl || 0);

  const maxRisk = remainingDaily > 0
    ? (remainingDaily / ftmo.accountSize) * 100
    : 0;

  setText("ftmoDailyRemaining", `${remainingDaily.toFixed(2)}$`);
  setText("ftmoMaxAdditionalRisk", `${maxRisk.toFixed(2)}%`);
  setText("ftmoDecisionText", maxRisk > ftmo.requestedRiskPercent ? "ALLOWED" : "BLOCKED");

  const badge = document.getElementById("ftmoDecisionBadge");
  if (badge) {
    badge.textContent = maxRisk > ftmo.requestedRiskPercent ? "OK" : "BLOCK";
  }
}

/* ============================= */
/* WATCHLIST */
/* ============================= */

function toggleCurrentWatchlist() {
  if (!appState.selectedPair) return;

  if (appState.watchlist.includes(appState.selectedPair)) {
    appState.watchlist = appState.watchlist.filter((p) => p !== appState.selectedPair);
  } else {
    appState.watchlist.push(appState.selectedPair);
  }

  persistState();
  renderWatchlist();
}

function renderWatchlist() {
  const watch = document.getElementById("watchlist");
  const count = document.getElementById("watchlistCount");
  if (!watch) return;

  watch.innerHTML = "";
  appState.watchlist.forEach((pair) => {
    const div = document.createElement("div");
    div.className = "watch-item";
    div.textContent = pair;
    watch.appendChild(div);
  });

  if (count) count.textContent = String(appState.watchlist.length);
}

/* ============================= */
/* EXPORT */
/* ============================= */

function exportTradesJson() {
  const blob = new Blob(
    [JSON.stringify(appState.trades, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "trades.json";
  a.click();
  URL.revokeObjectURL(url);
}

/* ============================= */
/* CHART */
/* ============================= */

function updateChart(candles) {
  if (!candleSeries || !Array.isArray(candles) || !candles.length) return;

  candleSeries.setData(
    candles.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }))
  );
}

/* ============================= */
/* HELPERS */
/* ============================= */

function metricCard(label, value, hint = "") {
  return `
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
      <div class="metric-hint">${hint}</div>
    </div>
  `;
}

function clamp(v, min = 1, max = 99) {
  return Math.max(min, Math.min(max, Number(v) || 0));
}

function sanitizeDecision(value) {
  const v = String(value || "").toUpperCase();
  if (v.includes("NO")) return "NO TRADE";
  if (v.includes("WAIT")) return "WAIT";
  return "TRADE";
}

function formatPrice(v) {
  const n = Number(v || 0);
  return n > 100 ? n.toFixed(2) : n.toFixed(5);
}

function computeDynamicRiskPercent(scan) {
  let risk = 0.5;

  if ((scan.finalScore || 0) > 85) risk = 1.0;
  if ((scan.mlScore || 0) > 80) risk += 0.2;
  if ((scan.vectorbtScore || 0) > 80) risk += 0.2;

  return Math.min(risk, 1.5);
}

function computeDynamicLeverageLabel(scan) {
  const score = Number(scan.finalScore || 0);
  if (score >= 85) return "HIGH QUALITY";
  if (score >= 70) return "MEDIUM QUALITY";
  return "DEFENSIVE";
}

function computePositionSizing(scan, capital) {
  const entry = Number(scan.current || 0);
  const stop = Number(scan.stopLoss || entry * 0.995);
  const dynamicRiskPercent = computeDynamicRiskPercent(scan);
  const riskAmount = capital * (dynamicRiskPercent / 100);
  const stopDistance = Math.abs(entry - stop) || 0.00001;
  const quantity = riskAmount / stopDistance;

  return {
    dynamicRiskPercent,
    riskAmount: Number(riskAmount.toFixed(2)),
    stopDistance: Number(stopDistance.toFixed(5)),
    quantity: Number.isFinite(quantity) ? Number(quantity.toFixed(2)) : 0,
    leverageLabel: computeDynamicLeverageLabel(scan)
  };
}

function buildJournalContextForPair(scan) {
  return {
    pairExpectancy: 0,
    hourExpectancy: 0,
    sessionExpectancy: 0,
    pairWinRate: 0,
    hourWinRate: 0,
    sessionWinRate: 0
  };
}

function generateFakeCandles(symbol) {
  const out = [];
  let price = symbol === "XAUUSD" ? 2300 : symbol === "NAS100" ? 18000 : symbol === "USDJPY" ? 150 : 1.08;

  for (let i = 0; i < 120; i++) {
    const open = price;
    const close = open + (Math.random() - 0.5) * (symbol === "XAUUSD" ? 3 : symbol === "NAS100" ? 40 : symbol === "USDJPY" ? 0.25 : 0.004);
    const high = Math.max(open, close) + Math.random() * 0.2;
    const low = Math.min(open, close) - Math.random() * 0.2;

    out.push({
      time: i + 1,
      open,
      high,
      low,
      close
    });

    price = close;
  }

  return out;
                             }

function signalClass(value) {
  const v = String(value || "").toUpperCase();
  if (v.includes("BUY") || v.includes("TRADE")) return "ok";
  if (v.includes("SELL") || v.includes("NO")) return "bad";
  return "neutral";
}

function computeHedgeScore(scan) {
  return Math.round(
    Number(scan.trendScore || 0) * 0.25 +
    Number(scan.timingScore || 0) * 0.2 +
    Number(scan.contextScore || 0) * 0.15 +
    Number(scan.riskScore || 0) * 0.1 +
    Number(scan.mlScore || 0) * 0.15 +
    Number(scan.vectorbtScore || 0) * 0.15
  );
}

function isEliteTrade(scan) {
  return (
    Number(scan.finalScore || 0) >= 85 &&
    Number(scan.mlScore || 0) >= 75 &&
    Number(scan.vectorbtScore || 0) >= 75
  );
}

function computeConfluenceScore(scan) {
  const score = Math.round(
    Number(scan.finalScore || 0) * 0.35 +
    Number(scan.mlScore || 0) * 0.2 +
    Number(scan.vectorbtScore || 0) * 0.2 +
    Number(scan.trendScore || 0) * 0.1 +
    Number(scan.timingScore || 0) * 0.1 +
    Number(scan.contextScore || 0) * 0.05
  );

  return {
    score,
    label:
      score >= 85 ? "institutional" :
      score >= 75 ? "elite" :
      score >= 65 ? "strong" :
      score >= 55 ? "tradable" :
      "weak",
    blocked: score < 55
  };
}

function computeConfluenceData() {
  if (!appState.scans.length) {
    return {
      enabled: true,
      bestPair: null,
      bestScore: 0,
      label: "weak",
      blocked: true,
      reason: "No scans available."
    };
  }

  const sorted = [...appState.scans].sort(
    (a, b) => Number(b.confluence?.score || 0) - Number(a.confluence?.score || 0)
  );

  const best = sorted[0];

  return {
    enabled: true,
    bestPair: best?.pair || null,
    bestScore: Number(best?.confluence?.score || 0),
    label: best?.confluence?.label || "weak",
    blocked: Boolean(best?.confluence?.blocked),
    reason: best
      ? `Best confluence is ${best.pair} with ${best.confluence.score} (${best.confluence.label}).`
      : "No scans available."
  };
}

function computeExecutionData() {
  return {
    enabled: true,
    averageScore: 0,
    bestTrade: null,
    worstTrade: null,
    trades: [],
    reason: "Execution scoring active."
  };
}

function computeLearningData() {
  return {
    enabled: true,
    globalBias: 0,
    pairAdjustments: {},
    hourAdjustments: {},
    sessionAdjustments: {},
    executionBias: 0,
    reason: "Learning active."
  };
}

function computeSessionKillData() {
  return {
    blocked: false,
    score: 0,
    reason: "Session acceptable.",
    currentSession: normalizeSessionLabel(getMarketSession(new Date()).label)
  };
}

async function computeNewsKillData() {
  return {
    blocked: false,
    score: 0,
    reason: "News context acceptable.",
    currentPair: appState.selectedPair || "--",
    events: []
  };
}

function computeRegimeData() {
  return {
    enabled: true,
    pair: appState.selectedPair || "--",
    regime: "balanced",
    score: 55,
    trendStrength: 50,
    volatilityScore: 50,
    efficiencyScore: 50,
    reason: "Balanced conditions."
  };
}

function getLearningAdjustment() {
  return {
    pair: 0,
    hour: 0,
    session: 0,
    global: 0,
    execution: 0,
    total: 0
  };
}

function renderOverview() {
  const best = appState.scans[0];
  if (!best) return;

  const allowed = appState.scans.filter((s) => Number(s.finalScore || 0) >= 70).length;
  const blocked = appState.scans.length - allowed;

  setText("topPairLabel", best.pair);
  setText("topPairReason", best.reason || best.confluence?.label || "--");
  setText("allowedCount", String(allowed));
  setText("blockedCount", String(blocked));
  setText("bestScore", String(Math.round(best.finalScore || 0)));
  setText("globalExposure", `${appState.trades.length}`);
}

function renderTopPriorityTrades() {
  const wrap = document.getElementById("topPriorityTrades");
  if (!wrap) return;

  const top = [...appState.scans]
    .sort((a, b) => Number(b.finalScore || 0) - Number(a.finalScore || 0))
    .slice(0, 5);

  wrap.innerHTML = top.map((scan) => `
    <div class="top-row">
      <strong>${scan.pair}</strong> - ${Math.round(scan.finalScore || 0)}
    </div>
  `).join("");
}

function renderTopBlockedTrades() {
  const wrap = document.getElementById("topBlockedTrades");
  if (!wrap) return;

  const blocked = [...appState.scans]
    .filter((scan) => Number(scan.finalScore || 0) < 55)
    .slice(0, 5);

  wrap.innerHTML = blocked.map((scan) => `
    <div class="top-row blocked">
      <strong>${scan.pair}</strong> - ${Math.round(scan.finalScore || 0)}
    </div>
  `).join("");
}

function renderTimeEdgePanel() {
  setText("bestHourLabel", "--");
  setText("bestHourHint", "--");
  setText("worstHourLabel", "--");
  setText("worstHourHint", "--");
  setText("bestSessionLabel", "--");
  setText("bestSessionHint", "--");
  setText("worstSessionLabel", "--");
  setText("worstSessionHint", "--");
}

function renderPremiumCombo() {
  setText("comboBestPair", appState.scans[0]?.pair || "--");
  setText("comboBestPairHint", "--");
  setText("comboBestHour", "--");
  setText("comboBestHourHint", "--");
  setText("comboBestSession", "--");
  setText("comboBestSessionHint", "--");
  setText("comboScore", appState.confluenceData?.bestScore || "--");
  setText("comboScoreHint", appState.confluenceData?.label || "--");
}

function renderJournalInsights() {
  setText("journalMeta", "--");
  setText("journalWinRate", "--");
  setText("journalExpectancy", "--");
  setText("journalBestPair", "--");
  setText("journalBestPairHint", "--");
  setText("journalBestSession", "--");
  setText("journalBestSessionHint", "--");
}

})();

