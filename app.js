const STORAGE_KEY = "ftmo-edge-ai-state-v4";

const TIMEFRAMES = ["M5", "M15", "H1", "H4"];
const PAIRS = [
  { symbol: "EURUSD", group: "forex", base: "EUR", quote: "USD" },
  { symbol: "GBPUSD", group: "forex", base: "GBP", quote: "USD" },
  { symbol: "USDJPY", group: "yen", base: "USD", quote: "JPY" },
  { symbol: "EURJPY", group: "yen", base: "EUR", quote: "JPY" },
  { symbol: "GBPJPY", group: "yen", base: "GBP", quote: "JPY" },
  { symbol: "AUDUSD", group: "forex", base: "AUD", quote: "USD" },
  { symbol: "NZDUSD", group: "forex", base: "NZD", quote: "USD" },
  { symbol: "USDCAD", group: "forex", base: "USD", quote: "CAD" },
  { symbol: "USDCHF", group: "forex", base: "USD", quote: "CHF" },
  { symbol: "XAUUSD", group: "metals", base: "XAU", quote: "USD" },
  { symbol: "NAS100", group: "indices", base: "NAS", quote: "USD" },
  { symbol: "GER40", group: "indices", base: "GER", quote: "EUR" }
];

const els = {};
let chart;
let candleSeries;

const defaultState = {
  timeframe: "M15",
  strategy: "balanced",
  marketFilter: "all",
  search: "",
  selectedPair: "EURUSD",
  watchlist: [],
  trades: [],
  scans: [],
  aiDecisionCache: {},
  aiSettings: {
    model: "llama-3.1-8b-instant",
    mode: "strict",
    cooldownMinutes: 90
  }
};

const appState = loadState();

document.addEventListener("DOMContentLoaded", () => {
  cacheEls();
  hydrateUiFromState();
  bindEvents();
  setupChart();
  refreshAll();
});

function cacheEls() {
  [
    "localClock", "activeSessionPill", "riskPill", "marketBiasPill",
    "sessionHeadline", "sessionSubline", "bestScore",
    "topPairLabel", "topPairReason", "allowedCount", "blockedCount", "globalExposure",
    "timeframeRow", "strategyMode", "marketFilter", "pairSearch", "pairCount",
    "pairList", "selectedPairName", "selectedSignalBadge", "summaryMetrics",
    "trendMini", "confidenceMini", "rrMini", "aiMini", "chart",
    "reasonList", "gatekeeperBox", "tradeForm", "tradePair", "tradeDirection",
    "tradeCapital", "tradeEntry", "riskPercent", "tradeNotes", "tradeSuggestionBox",
    "watchlist", "watchlistCount", "tradeList", "tradeStats",
    "watchlistBtn", "exportBtn", "clearTradesBtn", "refreshBtn", "recheckAiBtn",
    "decisionAsset", "decisionBadge", "decisionText", "decisionReason", "decisionConfidence",
    "decisionRiskMode", "decisionAction", "decisionWindow",
    "settingsBtn", "settingsModal", "closeSettingsBtn", "saveSettingsBtn",
    "groqModel", "aiMode", "macroCooldown", "maxRiskPerTrade"
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultState);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(defaultState),
      ...parsed,
      aiSettings: {
        ...defaultState.aiSettings,
        ...(parsed.aiSettings || {})
      }
    };
  } catch {
    return structuredClone(defaultState);
  }
}

function persistState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

function hydrateUiFromState() {
  renderTimeframeButtons();
  els.strategyMode.value = appState.strategy;
  els.marketFilter.value = appState.marketFilter;
  els.pairSearch.value = appState.search;
  els.groqModel.value = appState.aiSettings.model || defaultState.aiSettings.model;
  els.aiMode.value = appState.aiSettings.mode || defaultState.aiSettings.mode;
  els.macroCooldown.value = appState.aiSettings.cooldownMinutes || defaultState.aiSettings.cooldownMinutes;
  els.maxRiskPerTrade.value = "1";
}

function renderTimeframeButtons() {
  els.timeframeRow.innerHTML = "";

  TIMEFRAMES.forEach((tf) => {
    const btn = document.createElement("button");
    btn.className = "ghost-btn";
    btn.textContent = tf;

    if (appState.timeframe === tf) {
      btn.classList.add("active-chip");
    }

    btn.addEventListener("click", () => {
      appState.timeframe = tf;
      persistState();
      renderTimeframeButtons();
      refreshAll(true);
    });

    els.timeframeRow.appendChild(btn);
  });
}

function bindEvents() {
  els.strategyMode.addEventListener("change", () => {
    appState.strategy = els.strategyMode.value;
    persistState();
    refreshAll(true);
  });

  els.marketFilter.addEventListener("change", () => {
    appState.marketFilter = els.marketFilter.value;
    persistState();
    renderPairList();
    renderOverview();
  });

  els.pairSearch.addEventListener("input", () => {
    appState.search = els.pairSearch.value.trim().toUpperCase();
    persistState();
    renderPairList();
    renderOverview();
  });

  els.refreshBtn.addEventListener("click", () => refreshAll(true));
  els.recheckAiBtn.addEventListener("click", () => refreshAll(true));

  els.tradeForm.addEventListener("submit", onAddTrade);
  els.watchlistBtn.addEventListener("click", toggleCurrentWatchlist);
  els.exportBtn.addEventListener("click", exportTradesJson);
  els.clearTradesBtn.addEventListener("click", clearTrades);

  els.settingsBtn.addEventListener("click", () => {
    els.settingsModal.classList.remove("hidden");
  });

  els.closeSettingsBtn.addEventListener("click", () => {
    els.settingsModal.classList.add("hidden");
  });

  els.saveSettingsBtn.addEventListener("click", () => {
    appState.aiSettings.model = els.groqModel.value;
    appState.aiSettings.mode = els.aiMode.value;
    appState.aiSettings.cooldownMinutes = Number(els.macroCooldown.value) || 90;
    persistState();
    els.settingsModal.classList.add("hidden");
    refreshAll(true);
  });
}

function setupChart() {
  chart = LightweightCharts.createChart(els.chart, {
    layout: {
      background: { color: "rgba(0,0,0,0)" },
      textColor: "#dbe7ff"
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.05)" },
      horzLines: { color: "rgba(255,255,255,0.05)" }
    },
    width: els.chart.clientWidth,
    height: 280,
    rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
    timeScale: { borderColor: "rgba(255,255,255,0.08)" }
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: "#24d27e",
    downColor: "#ff667f",
    wickUpColor: "#24d27e",
    wickDownColor: "#ff667f",
    borderVisible: false
  });

  window.addEventListener("resize", () => {
    chart.applyOptions({ width: els.chart.clientWidth });
  });
}

async function refreshAll(forceAi = false) {
  updateClockAndSession();

  const scans = await Promise.all(
    PAIRS.map((item) => scanPair(item, appState.timeframe, appState.strategy))
  );

  appState.scans = scans.sort((a, b) => b.finalScore - a.finalScore);

  if (!appState.scans.some((scan) => scan.pair === appState.selectedPair)) {
    appState.selectedPair = appState.scans[0]?.pair || "EURUSD";
  }

  renderOverview();
  renderPairList();
  renderSelectedPair();
  renderTrades();
  renderWatchlist();
  persistState();

  await refreshAiDecision(forceAi);
}

function updateClockAndSession() {
  const now = new Date();
  const session = getMarketSession(now);
  const risk = getGlobalRiskSnapshot();

  els.localClock.textContent = now.toLocaleString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit"
  });

  els.activeSessionPill.textContent = session.label;
  els.riskPill.textContent = risk.label;
  els.marketBiasPill.textContent = session.biasLabel;
  els.sessionHeadline.textContent = session.headline;
  els.sessionSubline.textContent = risk.description;
}

function getMarketSession(date) {
  const hourParis = Number(
    date.toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );

  const tokyo = hourParis >= 1 && hourParis < 10;
  const london = hourParis >= 9 && hourParis < 18;
  const newYork = hourParis >= 14 && hourParis < 23;
  const overlap = london && newYork;

  if (overlap) {
    return {
      label: "London + New York",
      headline: "Forte liquidité : la sélection devient plus stricte mais plus intéressante.",
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
      headline: "Session Asie : le système favorise JPY, AUD et NZD.",
      biasLabel: "Bias Asie"
    };
  }

  return {
    label: "Off-session",
    headline: "Liquidité plus faible : l’app refuse davantage de trades.",
    biasLabel: "Liquidité faible"
  };
}

async function scanPair(item, timeframe, strategy) {
  const market = await fetchMarketData(item.symbol, timeframe);
  const candles = market.candles?.length ? market.candles : generateCandles(item.symbol, timeframe);

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const current = Number(market.price ?? closes.at(-1));
  const ema20 = Number(market.indicators?.ema20 ?? emaSeries(closes, 20).at(-1));
  const ema50 = Number(market.indicators?.ema50 ?? emaSeries(closes, 50).at(-1));
  const rsi14 = Number(market.indicators?.rsi14 ?? rsi(closes, 14));
  const atr14 = Number(market.indicators?.atr14 ?? atr(highs, lows, closes, 14));
  const momentum = Number(
    market.indicators?.momentum ??
    (((current - closes.at(-12)) / closes.at(-12)) * 100)
  );

  const support = Math.min(...lows.slice(-20));
  const resistance = Math.max(...highs.slice(-20));
  const macdLine = ema(closes, 12) - ema(closes, 26);
  const sessionBoost = getSessionBoost(item.symbol);
  const macroPenalty = estimateMacroPenalty(item.symbol);
  const structureBias = detectStructure(highs, lows);
  const candleBias = detectLastCandleSignal(candles);
  const historicalEdge = historicalSimilarity(item.symbol, timeframe, rsi14, momentum, atr14);
  const correlationPenalty = getCorrelationPenalty(item.symbol);
  const spreadPenalty = getSpreadPenalty(item.symbol, atr14);
  const offSessionPenalty = getOffSessionPenalty(item.symbol);

  let trendScore = 50;
  trendScore += ema20 > ema50 ? 18 : -18;
  trendScore += current > ema20 ? 8 : -8;
  trendScore += momentum > 0 ? 6 : -6;

  let timingScore = 50;
  timingScore += candleBias;
  timingScore += structureBias;
  timingScore += macdLine > 0 ? 7 : -7;
  timingScore += (current > resistance * 0.998 || current < support * 1.002) ? 6 : 0;

  let riskScore = 70;
  riskScore -= macroPenalty;
  riskScore -= correlationPenalty;
  riskScore -= spreadPenalty;
  riskScore -= offSessionPenalty;

  let contextScore = 50;
  contextScore += sessionBoost;
  contextScore += historicalEdge;
  contextScore += strategyBonus(strategy, {
    rsi14,
    current,
    support,
    resistance,
    ema20,
    ema50
  });

  const finalScore = clamp(
    Math.round(
      trendScore * 0.28 +
      timingScore * 0.24 +
      riskScore * 0.26 +
      contextScore * 0.22
    ),
    1,
    99
  );

  const gatekeeper = buildGatekeeper({
    macroPenalty,
    spreadPenalty,
    offSessionPenalty,
    correlationPenalty,
    finalScore,
    atr14,
    current
  });

  const signal = gatekeeper.allowed
    ? finalScore >= 82
      ? "STRONG BUY"
      : finalScore >= 68
        ? "BUY"
        : finalScore <= 22
          ? "STRONG SELL"
          : finalScore <= 36
            ? "SELL"
            : "WAIT"
    : gatekeeper.decision;

  const direction = signal.includes("SELL") ? "sell" : "buy";
  const stopLoss = direction === "buy" ? current - atr14 * 1.4 : current + atr14 * 1.4;
  const takeProfit = direction === "buy" ? current + atr14 * 2.6 : current - atr14 * 2.6;
  const rr = Math.abs((takeProfit - current) / ((current - stopLoss) || 1));

  return {
    pair: item.symbol,
    group: item.group,
    timeframe,
    marketSource: market.source || "unknown",
    candles,
    current,
    ema20,
    ema50,
    rsi14,
    atr14,
    momentum,
    support,
    resistance,
    macroPenalty,
    correlationPenalty,
    spreadPenalty,
    offSessionPenalty,
    trendScore: clamp(Math.round(trendScore), 1, 99),
    timingScore: clamp(Math.round(timingScore), 1, 99),
    riskScore: clamp(Math.round(riskScore), 1, 99),
    contextScore: clamp(Math.round(contextScore), 1, 99),
    finalScore,
    gatekeeper,
    signal,
    direction,
    stopLoss,
    takeProfit,
    rr: rr.toFixed(2),
    confidence: clamp(Math.round(finalScore * 0.72 + Math.max(0, riskScore) * 0.28), 1, 99),
    trend: ema20 > ema50 ? "Bullish" : "Bearish",
    reasons: buildReasons({
      ema20,
      ema50,
      rsi14,
      momentum,
      structureBias,
      macroPenalty,
      correlationPenalty,
      spreadPenalty,
      gatekeeper
    })
  };
}

function buildGatekeeper({
  macroPenalty,
  spreadPenalty,
  offSessionPenalty,
  correlationPenalty,
  finalScore,
  atr14,
  current
}) {
  const volatilityRisk = (atr14 / current) * 100;

  const checks = [
    { label: "Macro", ok: macroPenalty < 14, value: macroPenalty < 14 ? "OK" : "Bloqué" },
    { label: "Spread", ok: spreadPenalty < 10, value: spreadPenalty < 10 ? "OK" : "Trop cher" },
    { label: "Session", ok: offSessionPenalty < 8, value: offSessionPenalty < 8 ? "OK" : "Faible liquidité" },
    { label: "Corrélation", ok: correlationPenalty < 10, value: correlationPenalty < 10 ? "OK" : "Surexposé" },
    { label: "Volatilité", ok: volatilityRisk < 1.6, value: volatilityRisk < 1.6 ? "OK" : "Instable" },
    { label: "Setup", ok: finalScore >= 58, value: finalScore >= 58 ? "Valide" : "Faible" }
  ];

  const failed = checks.filter((c) => !c.ok).length;

  if (failed >= 2) return { allowed: false, decision: "NO TRADE", checks };
  if (failed === 1 || finalScore < 65) return { allowed: false, decision: "WAIT", checks };
  return { allowed: true, decision: "TRADE", checks };
}

function renderOverview() {
  const filtered = getFilteredScans();
  const best = filtered[0];
  const allowed = filtered.filter((s) => s.gatekeeper.decision === "TRADE").length;
  const blocked = filtered.filter((s) => s.gatekeeper.decision === "NO TRADE").length;
  const exposure = calculateOpenExposure();

  els.topPairLabel.textContent = best ? `${best.pair} · ${best.signal}` : "--";
  els.topPairReason.textContent = best ? `${best.trend} · confiance ${best.confidence}` : "--";
  els.allowedCount.textContent = String(allowed);
  els.blockedCount.textContent = String(blocked);
  els.globalExposure.textContent = `${exposure.toFixed(2)}%`;
  els.bestScore.textContent = best?.finalScore ?? "--";
}

function getFilteredScans() {
  let list = [...appState.scans];

  if (appState.marketFilter !== "all") {
    list = list.filter((scan) => scan.group === appState.marketFilter);
  }

  if (appState.search) {
    list = list.filter((scan) => scan.pair.includes(appState.search));
  }

  return list;
}

function renderPairList() {
  const list = getFilteredScans();
  els.pairCount.textContent = `${list.length} paire(s)`;
  els.pairList.innerHTML = "";

  list.forEach((scan) => {
    const item = document.createElement("button");
    item.className = "pair-item";

    item.addEventListener("click", () => {
      appState.selectedPair = scan.pair;
      persistState();
      renderSelectedPair();
      refreshAiDecision(true);
    });

    const signalClass = scan.signal.includes("BUY")
      ? "signal-buy"
      : scan.signal.includes("SELL") || scan.signal.includes("NO")
        ? "signal-sell"
        : "signal-wait";

    item.innerHTML = `
      <div class="pair-left">
        <div class="pair-title-row">
          <span class="pair-symbol">${scan.pair}</span>
          <span class="signal-badge ${signalClass}">${scan.gatekeeper.decision}</span>
        </div>
        <div class="pair-meta">
          <span class="tag">${scan.trend}</span>
          <span class="tag">Conf ${scan.confidence}</span>
          <span class="tag">RR ${scan.rr}</span>
          <span class="tag">IA ${appState.aiDecisionCache[scan.pair]?.decision || "--"}</span>
        </div>
      </div>
      <div class="score-badge ${scan.finalScore >= 70 ? "good" : scan.finalScore <= 35 ? "bad" : ""}">
        ${scan.finalScore}
      </div>
    `;

    els.pairList.appendChild(item);
  });
}

function renderSelectedPair() {
  const scan = appState.scans.find((s) => s.pair === appState.selectedPair) || appState.scans[0];
  if (!scan) return;

  const ai = appState.aiDecisionCache[scan.pair];

  els.selectedPairName.textContent = scan.pair;
  els.selectedSignalBadge.textContent = ai?.decision || scan.gatekeeper.decision;
  els.tradePair.value = scan.pair;
  els.tradeDirection.value = scan.direction;

  els.summaryMetrics.innerHTML = [
    metricCard("Prix", formatPrice(scan.current), scan.trend),
    metricCard("Trend", `${scan.trendScore}`, "force directionnelle"),
    metricCard("Timing", `${scan.timingScore}`, "qualité d’entrée"),
    metricCard("Risk", `${scan.riskScore}`, "macro, spread, corrélation"),
    metricCard("Context", `${scan.contextScore}`, "session + historique"),
    metricCard("Source", scan.marketSource || "--", "marché live / fallback")
  ].join("");

  els.trendMini.textContent = scan.trend;
  els.confidenceMini.textContent = `${ai?.confidence ?? scan.confidence}%`;
  els.rrMini.textContent = scan.rr;
  els.aiMini.textContent = ai?.decision || "--";

  els.reasonList.innerHTML = scan.reasons.map((reason) => `<li>${reason}</li>`).join("");
  els.gatekeeperBox.innerHTML = scan.gatekeeper.checks.map((check) => `
    <div class="gate-row">
      <span>${check.label}</span>
      <strong class="${check.ok ? "gate-ok" : check.value === "Faible liquidité" ? "gate-warn" : "gate-bad"}">
        ${check.value}
      </strong>
    </div>
  `).join("");

  renderTradeSuggestion(scan, ai);
  renderChart(scan.candles);
}

function metricCard(label, value, hint) {
  return `
    <article class="metric-card">
      <span class="muted">${label}</span>
      <strong>${value}</strong>
      <small>${hint}</small>
    </article>
  `;
}

function renderChart(candles) {
  candleSeries.setData(
    candles.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }))
  );
  chart.timeScale().fitContent();
}

function renderTradeSuggestion(scan, ai) {
  const decision = ai?.decision || scan.gatekeeper.decision;
  const confidence = ai?.confidence ?? scan.confidence;
  const explanation = ai?.reason || "Le moteur privilégie prudence et sélection stricte.";

  els.tradeSuggestionBox.innerHTML = `
    <strong>${decision}</strong><br/>
    Confiance : ${confidence}%<br/>
    Direction suggérée : ${scan.direction.toUpperCase()}<br/>
    Entrée repère : ${formatPrice(scan.current)}<br/>
    Stop loss : ${formatPrice(scan.stopLoss)}<br/>
    Take profit : ${formatPrice(scan.takeProfit)}<br/>
    Ratio RR : ${scan.rr}<br/>
    Exit dynamique : break-even à 1R, sortie partielle à 1.5R, trailing ATR au-delà.<br/>
    Motif principal : ${explanation}
  `;
}

function renderWatchlist() {
  els.watchlist.innerHTML = "";
  els.watchlistCount.textContent = `${appState.watchlist.length} actif(s)`;

  if (!appState.watchlist.length) {
    els.watchlist.innerHTML = `<div class="muted">Aucun actif en watchlist.</div>`;
    return;
  }

  appState.watchlist.forEach((pair) => {
    const scan = appState.scans.find((s) => s.pair === pair);
    if (!scan) return;

    const card = document.createElement("div");
    card.className = "watch-item";
    card.innerHTML = `
      <div class="watch-item-header">
        <div>
          <strong>${scan.pair}</strong>
          <div class="muted small">${scan.gatekeeper.decision} · score ${scan.finalScore}</div>
        </div>
        <span class="signal-badge">${appState.aiDecisionCache[scan.pair]?.decision || "--"}</span>
      </div>
      <div class="watch-item-body">
        <div>Prix: ${formatPrice(scan.current)}</div>
        <div>Trend: ${scan.trend}</div>
      </div>
      <div class="watch-actions">
        <button class="mini-btn" data-open="${scan.pair}">Ouvrir</button>
        <button class="mini-btn" data-remove="${scan.pair}">Retirer</button>
      </div>
    `;

    card.querySelector(`[data-open="${scan.pair}"]`).addEventListener("click", () => {
      appState.selectedPair = scan.pair;
      persistState();
      renderSelectedPair();
      refreshAiDecision(true);
    });

    card.querySelector(`[data-remove="${scan.pair}"]`).addEventListener("click", () => {
      appState.watchlist = appState.watchlist.filter((p) => p !== scan.pair);
      persistState();
      renderWatchlist();
    });

    els.watchlist.appendChild(card);
  });
}

function renderTrades() {
  els.tradeList.innerHTML = "";
  els.tradeStats.textContent = `${appState.trades.length} trade(s)`;

  if (!appState.trades.length) {
    els.tradeList.innerHTML = `<div class="muted">Aucun trade enregistré.</div>`;
    return;
  }

  appState.trades.forEach((trade) => {
    const card = document.createElement("div");
    card.className = "trade-item";
    card.innerHTML = `
      <div class="trade-item-header">
        <div>
          <strong>${trade.pair}</strong>
          <div class="muted small">${trade.direction.toUpperCase()} · ${trade.status}</div>
        </div>
        <span class="signal-badge">${trade.aiDecision}</span>
      </div>
      <div class="trade-item-body">
        <div>Entrée: ${trade.entry}</div>
        <div>SL: ${trade.stopLoss}</div>
        <div>TP: ${trade.takeProfit}</div>
        <div>Risque: ${trade.riskPercent}%</div>
        <div>Capital: ${trade.capital}</div>
        <div>Créé: ${trade.createdAt}</div>
        <div>Notes: ${trade.notes || "-"}</div>
      </div>
      <div class="trade-actions">
        <button class="mini-btn" data-close="${trade.id}">Archiver</button>
        <button class="mini-btn" data-delete="${trade.id}">Supprimer</button>
      </div>
    `;

    card.querySelector(`[data-close="${trade.id}"]`).addEventListener("click", () => {
      const target = appState.trades.find((t) => t.id === trade.id);
      if (target) {
        target.status = "archivé";
        persistState();
        renderTrades();
        renderOverview();
      }
    });

    card.querySelector(`[data-delete="${trade.id}"]`).addEventListener("click", () => {
      appState.trades = appState.trades.filter((t) => t.id !== trade.id);
      persistState();
      renderTrades();
      renderOverview();
    });

    els.tradeList.appendChild(card);
  });
}

async function refreshAiDecision(force = false) {
  const selectedScan = appState.scans.find((s) => s.pair === appState.selectedPair) || appState.scans[0];
  if (!selectedScan) return;

  els.decisionAsset.textContent = selectedScan.pair;

  const cacheKey = [
    selectedScan.pair,
    selectedScan.finalScore,
    selectedScan.gatekeeper.decision,
    appState.aiSettings.mode,
    appState.aiSettings.model,
    appState.aiSettings.cooldownMinutes
  ].join("_");

  if (!force && appState.aiDecisionCache[selectedScan.pair]?.cacheKey === cacheKey) {
    applyDecisionUi(selectedScan.pair, appState.aiDecisionCache[selectedScan.pair]);
    renderSelectedPair();
    renderPairList();
    return;
  }

  let decision;
  try {
    decision = await askServerForDecision(selectedScan);
  } catch {
    decision = localDecisionEngine(selectedScan);
  }

  decision.cacheKey = cacheKey;
  appState.aiDecisionCache[selectedScan.pair] = decision;
  persistState();

  applyDecisionUi(selectedScan.pair, decision);
  renderSelectedPair();
  renderPairList();
}

function applyDecisionUi(pair, decision) {
  els.decisionAsset.textContent = pair;
  els.decisionBadge.textContent = decision.decision;
  els.decisionText.textContent = decision.title;
  els.decisionReason.textContent = decision.reason;
  els.decisionConfidence.textContent = `${decision.confidence}%`;
  els.decisionRiskMode.textContent = `Mode ${appState.aiSettings.mode}`;
  els.decisionAction.textContent = decision.action;
  els.decisionWindow.textContent = decision.window;
}

async function askServerForDecision(scan) {
  const response = await fetch("/api/ai-decision", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      aiMode: appState.aiSettings.mode,
      model: appState.aiSettings.model,
      leverage: "x10",
      pair: scan.pair,
      timeframe: scan.timeframe,
      signal: scan.signal,
      trend: scan.trend,
      finalScore: scan.finalScore,
      confidence: scan.confidence,
      trendScore: scan.trendScore,
      timingScore: scan.timingScore,
      riskScore: scan.riskScore,
      contextScore: scan.contextScore,
      rr: scan.rr,
      gatekeeper: scan.gatekeeper,
      reasons: scan.reasons,
      cooldownMinutes: appState.aiSettings.cooldownMinutes
    })
  });

  if (!response.ok) {
    throw new Error(`AI endpoint error ${response.status}`);
  }

  const data = await response.json();

  return {
    decision: sanitizeDecision(data.decision),
    title: data.title || "Décision IA",
    reason: data.reason || "Le moteur recommande la prudence.",
    confidence: clamp(Number(data.confidence) || scan.confidence, 1, 99),
    action: data.action || "Attendre une meilleure fenêtre",
    window: data.window || "À revalider au prochain refresh"
  };
}

async function fetchMarketData(pair, timeframe) {
  try {
    const res = await fetch(
      `/api/market-data?pair=${encodeURIComponent(pair)}&timeframe=${encodeURIComponent(timeframe)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      }
    );

    if (!res.ok) {
      throw new Error(`market-data ${res.status}`);
    }

    const data = await res.json();

    return {
      source: data.source || "unknown",
      price: data.price,
      candles: Array.isArray(data.candles) ? data.candles : [],
      indicators: data.indicators || {}
    };
  } catch {
    return {
      source: "client-fallback",
      price: null,
      candles: [],
      indicators: {}
    };
  }
}

function localDecisionEngine(scan) {
  const strictness = appState.aiSettings.mode;
  const aggressiveBias = strictness === "aggressive" ? 5 : 0;
  const strictPenalty = strictness === "strict" ? 7 : 0;

  if (scan.gatekeeper.decision === "NO TRADE") {
    return {
      decision: "NO TRADE",
      title: "Trade refusé",
      reason: "Le garde-fou détecte trop de points faibles sur risque, contexte ou qualité du setup.",
      confidence: clamp(86 + strictPenalty, 1, 99),
      action: "Ne pas trader cet actif maintenant",
      window: "Attendre une restructuration du prix"
    };
  }

  if (scan.gatekeeper.decision === "WAIT" || scan.finalScore < 72 - aggressiveBias) {
    return {
      decision: "WAIT",
      title: "Attendre confirmation",
      reason: "Le setup existe mais l’avantage n’est pas encore assez propre pour du x10.",
      confidence: clamp(70 + strictPenalty, 1, 99),
      action: "Attendre confirmation ou meilleur timing",
      window: "Surveiller prochaine impulsion / cassure"
    };
  }

  return {
    decision: "TRADE",
    title: "Trade autorisé",
    reason: "Le contexte technique, le risque et le timing sont suffisamment alignés.",
    confidence: clamp(scan.confidence + 4 - strictPenalty, 1, 99),
    action: `Entrée ${scan.direction.toUpperCase()} possible`,
    window: "Fenêtre exploitable maintenant"
  };
}

function sanitizeDecision(value) {
  const normalized = String(value || "").toUpperCase().trim();
  if (normalized.includes("NO")) return "NO TRADE";
  if (normalized.includes("WAIT")) return "WAIT";
  return "TRADE";
}

function onAddTrade(event) {
  event.preventDefault();

  const scan = appState.scans.find((s) => s.pair === els.tradePair.value);
  if (!scan) return;

  const ai = appState.aiDecisionCache[scan.pair] || localDecisionEngine(scan);
  const capital = Number(els.tradeCapital.value || 0);
  const entry = Number(els.tradeEntry.value || scan.current);
  const riskPercent = Number(els.riskPercent.value || 1);

  const riskAmount = capital * (riskPercent / 100);
  const stopDistance = Math.abs(entry - scan.stopLoss) || 0.0001;
  const quantity = riskAmount / stopDistance;
  const leverageExposure = capital * 10;

  const trade = {
    id: crypto.randomUUID(),
    pair: scan.pair,
    direction: els.tradeDirection.value,
    capital: capital.toFixed(2),
    entry: entry.toFixed(5),
    riskPercent: riskPercent.toFixed(2),
    stopLoss: formatPrice(scan.stopLoss),
    takeProfit: formatPrice(scan.takeProfit),
    quantity: Number.isFinite(quantity) ? quantity.toFixed(2) : "0.00",
    leverageExposure: leverageExposure.toFixed(2),
    aiDecision: ai.decision,
    notes: els.tradeNotes.value.trim(),
    status: "actif",
    createdAt: new Date().toLocaleString("fr-FR")
  };

  appState.trades.unshift(trade);
  persistState();
  renderTrades();
  renderOverview();

  els.tradeForm.reset();
  els.tradePair.value = scan.pair;
  els.tradeDirection.value = scan.direction;
  els.riskPercent.value = "1";
}

function toggleCurrentWatchlist() {
  const pair = appState.selectedPair;
  if (!pair) return;

  if (appState.watchlist.includes(pair)) {
    appState.watchlist = appState.watchlist.filter((p) => p !== pair);
  } else {
    appState.watchlist.unshift(pair);
  }

  persistState();
  renderWatchlist();
}

function clearTrades() {
  appState.trades = [];
  persistState();
  renderTrades();
  renderOverview();
}

function exportTradesJson() {
  const blob = new Blob([JSON.stringify(appState.trades, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "ftmo-edge-trades.json";
  link.click();
  URL.revokeObjectURL(url);
}

function calculateOpenExposure() {
  return appState.trades
    .filter((trade) => trade.status === "actif")
    .reduce((sum, trade) => sum + Number(trade.riskPercent || 0), 0);
}

function getGlobalRiskSnapshot() {
  const exposure = calculateOpenExposure();

  if (exposure >= 3) {
    return {
      label: "Exposition élevée",
      description: "Le risque cumulé ouvert est déjà élevé. Le moteur devient plus dur."
    };
  }

  return {
    label: "Risque modéré",
    description: "Aucune surexposition immédiate détectée. Le moteur reste sélectif."
  };
}

function getSessionBoost(pair) {
  const session = getMarketSession(new Date()).label;

  if (session.includes("London") && (pair.includes("EUR") || pair.includes("GBP") || pair === "GER40")) return 10;
  if (session.includes("New York") && (pair.includes("USD") || pair === "XAUUSD" || pair === "NAS100")) return 10;
  if (session.includes("Tokyo") && pair.includes("JPY")) return 10;
  if (session === "Off-session") return -8;

  return 2;
}

function estimateMacroPenalty(pair) {
  const session = getMarketSession(new Date()).label;

  if (pair.includes("USD") && session.includes("New York")) return 4;
  if ((pair === "NAS100" || pair === "XAUUSD") && session.includes("New York")) return 6;

  return 2;
}

function getCorrelationPenalty(pair) {
  const activePairs = appState.trades
    .filter((trade) => trade.status === "actif")
    .map((trade) => trade.pair);

  const usdCount = activePairs.filter((p) => p.includes("USD")).length;

  if (pair.includes("USD") && usdCount >= 2) return 12;
  if (pair.includes("JPY") && activePairs.some((p) => p.includes("JPY"))) return 8;

  return 0;
}

function getSpreadPenalty(pair, atrValue) {
  const baseSpread =
    pair === "XAUUSD" ? 0.18 :
    pair === "NAS100" ? 0.28 :
    pair === "GER40" ? 0.22 :
    0.04;

  const normalized = atrValue <= 0 ? 0 : (baseSpread / atrValue) * 100;

  if (normalized > 18) return 12;
  if (normalized > 12) return 8;

  return 3;
}

function getOffSessionPenalty(pair) {
  const session = getMarketSession(new Date()).label;

  if (session === "Off-session") {
    return pair === "XAUUSD" || pair === "NAS100" ? 9 : 7;
  }

  return 0;
}

function strategyBonus(strategy, ctx) {
  if (strategy === "trend") return ctx.ema20 > ctx.ema50 ? 8 : -4;
  if (strategy === "reversal") return (ctx.rsi14 < 32 || ctx.rsi14 > 68) ? 10 : -5;
  if (strategy === "breakout") return (ctx.current > ctx.resistance * 0.998 || ctx.current < ctx.support * 1.002) ? 8 : -3;
  if (strategy === "scalp") return 4;
  return 0;
}

function historicalSimilarity(pair, timeframe, rsi14, momentum, atr14) {
  const seed = hashCode(`${pair}_${timeframe}`);
  const edge = Math.round((((seed % 15) - 7) + (momentum > 0 ? 4 : -2) + (rsi14 > 45 && rsi14 < 65 ? 3 : 0)) / 1.2);
  const penalty = atr14 > 1 ? -3 : 2;
  return edge + penalty;
}

function detectStructure(highs, lows) {
  const h1 = highs.at(-1);
  const h5 = highs.at(-5);
  const l1 = lows.at(-1);
  const l5 = lows.at(-5);

  if (h1 > h5 && l1 > l5) return 8;
  if (h1 < h5 && l1 < l5) return -8;
  return 0;
}

function detectLastCandleSignal(candles) {
  const c = candles.at(-1);
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 1;
  const upperWick = c.high - Math.max(c.close, c.open);
  const lowerWick = Math.min(c.close, c.open) - c.low;

  if (lowerWick > body * 1.3 && c.close > c.open) return 8;
  if (upperWick > body * 1.3 && c.close < c.open) return -8;
  if (body / range > 0.6 && c.close > c.open) return 5;
  if (body / range > 0.6 && c.close < c.open) return -5;

  return 0;
}

function buildReasons(ctx) {
  const reasons = [];
  reasons.push(ctx.ema20 > ctx.ema50 ? "EMA20 au-dessus de l’EMA50 : biais haussier." : "EMA20 sous EMA50 : biais baissier.");
  reasons.push(ctx.rsi14 > 45 && ctx.rsi14 < 65 ? "RSI dans une zone exploitable." : "RSI moins propre pour une entrée agressive.");
  reasons.push(ctx.momentum > 0 ? "Momentum positif récent." : "Momentum plus fragile ou baissier.");
  reasons.push(ctx.structureBias > 0 ? "Structure récente constructive." : ctx.structureBias < 0 ? "Structure récente fragile." : "Structure encore neutre.");
  reasons.push(ctx.macroPenalty > 0 ? "Le contexte macro réduit l’avantage." : "Pas de pénalité macro forte.");
  reasons.push(ctx.correlationPenalty > 0 ? "Corrélation / exposition déjà présente." : "Exposition corrélée acceptable.");
  reasons.push(ctx.spreadPenalty > 7 ? "Spread relativement coûteux." : "Spread encore acceptable.");
  reasons.push(ctx.gatekeeper.decision === "TRADE" ? "Le gatekeeper autorise l’entrée." : `Le gatekeeper recommande ${ctx.gatekeeper.decision}.`);
  return reasons;
}

function generateCandles(symbol, timeframe) {
  const base = getSymbolBasePrice(symbol);
  const stepMap = { M5: 0.0008, M15: 0.0014, H1: 0.0038, H4: 0.009 };
  const step =
    symbol === "XAUUSD" ? 4.8 :
    symbol === "NAS100" ? 28 :
    symbol === "GER40" ? 18 :
    symbol.includes("JPY") ? (stepMap[timeframe] || 0.0014) * 100 :
    (stepMap[timeframe] || 0.0014);

  const candles = [];
  let price = base;
  let time = Math.floor(Date.now() / 1000) - 160 * timeframeToSeconds(timeframe);

  for (let i = 0; i < 160; i += 1) {
    const wave = Math.sin(i / 7) * step * 1.2;
    const drift = (hashCode(symbol) % 2 === 0 ? 1 : -1) * step * 0.08;
    const noise = (Math.random() - 0.5) * step * 1.7;

    const open = price;
    const close = open + wave + drift + noise;
    const high = Math.max(open, close) + Math.abs(noise) * 1.1 + step * 0.35;
    const low = Math.min(open, close) - Math.abs(noise) * 1.1 - step * 0.35;

    candles.push({
      time,
      open: roundPrice(open, symbol),
      high: roundPrice(high, symbol),
      low: roundPrice(low, symbol),
      close: roundPrice(close, symbol)
    });

    price = close;
    time += timeframeToSeconds(timeframe);
  }

  return candles;
}

function getSymbolBasePrice(symbol) {
  const prices = {
    EURUSD: 1.0835,
    GBPUSD: 1.271,
    USDJPY: 151.15,
    EURJPY: 163.4,
    GBPJPY: 192.3,
    AUDUSD: 0.661,
    NZDUSD: 0.607,
    USDCAD: 1.352,
    USDCHF: 0.903,
    XAUUSD: 2350.5,
    NAS100: 18240,
    GER40: 18420
  };

  return prices[symbol] || 1;
}

function timeframeToSeconds(tf) {
  if (tf === "M5") return 300;
  if (tf === "M15") return 900;
  if (tf === "H1") return 3600;
  return 14400;
}

function roundPrice(value, symbol) {
  if (symbol === "XAUUSD") return Number(value.toFixed(2));
  if (symbol === "NAS100" || symbol === "GER40") return Number(value.toFixed(1));
  if (symbol.includes("JPY")) return Number(value.toFixed(3));
  return Number(value.toFixed(5));
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return n.toFixed(n > 100 ? 2 : 5);
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];

  for (let i = 0; i < values.length; i += 1) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }

  return out;
}

function ema(values, period) {
  return emaSeries(values, period).at(-1);
}

function rsi(values, period = 14) {
  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function atr(highs, lows, closes, period = 14) {
  const trs = [];

  for (let i = 1; i < highs.length; i += 1) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }

  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
