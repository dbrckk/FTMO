const STORAGE_KEY = "ftmo-edge-ai-state-v8";

const TIMEFRAMES = ["M5", "M15", "H1", "H4"];

const PAIRS = [
  { symbol: "EURUSD", group: "forex", tier: 1 },
  { symbol: "GBPUSD", group: "forex", tier: 1 },
  { symbol: "USDJPY", group: "yen", tier: 1 },
  { symbol: "USDCHF", group: "forex", tier: 1 },
  { symbol: "USDCAD", group: "forex", tier: 1 },
  { symbol: "AUDUSD", group: "forex", tier: 1 },
  { symbol: "NZDUSD", group: "forex", tier: 1 },
  { symbol: "EURGBP", group: "forex", tier: 1 },

  { symbol: "EURJPY", group: "yen", tier: 2 },
  { symbol: "GBPJPY", group: "yen", tier: 2 },
  { symbol: "AUDJPY", group: "yen", tier: 2 },
  { symbol: "CADJPY", group: "yen", tier: 2 },
  { symbol: "CHFJPY", group: "yen", tier: 2 },

  { symbol: "EURAUD", group: "forex", tier: 2 },
  { symbol: "EURNZD", group: "forex", tier: 2 },
  { symbol: "EURCAD", group: "forex", tier: 2 },
  { symbol: "EURCHF", group: "forex", tier: 2 },

  { symbol: "GBPAUD", group: "forex", tier: 2 },
  { symbol: "GBPNZD", group: "forex", tier: 2 },
  { symbol: "GBPCAD", group: "forex", tier: 2 },
  { symbol: "GBPCHF", group: "forex", tier: 2 },

  { symbol: "AUDNZD", group: "forex", tier: 3 },
  { symbol: "AUDCAD", group: "forex", tier: 3 },
  { symbol: "AUDCHF", group: "forex", tier: 3 },
  { symbol: "NZDCAD", group: "forex", tier: 3 },
  { symbol: "NZDCHF", group: "forex", tier: 3 },
  { symbol: "NZDJPY", group: "yen", tier: 3 },

  { symbol: "XAUUSD", group: "metals", tier: 2 },
  { symbol: "NAS100", group: "indices", tier: 2 },
  { symbol: "GER40", group: "indices", tier: 2 }
];

const els = {};
let chart = null;
let candleSeries = null;

const defaultState = {
  timeframe: "M15",
  strategy: "balanced",
  marketFilter: "all",
  search: "",
  selectedPair: "EURUSD",
  watchlist: [],
  trades: [],
  scans: [],
  journal: null,
  aiDecisionCache: {},
  mlScoreCache: {},
  onlyP1Mode: false,
  autoFocusBestP1: true,
  entrySniperMode: true,
  exitSniperMode: true,
  aiSettings: {
    model: "llama-3.1-8b-instant",
    mode: "strict",
    cooldownMinutes: 90
  },
  ftmo: {
    accountSize: 10000,
    dailyLossLimitPercent: 5,
    totalLossLimitPercent: 10,
    closedTodayPnl: 0,
    floatingPnl: 0,
    openRiskPercent: 0,
    requestedRiskPercent: 1
  },
  ftmoRiskResult: null
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
    "groqModel", "aiMode", "macroCooldown", "maxRiskPerTrade",
    "ftmoRiskTitle", "ftmoDecisionBadge", "ftmoDailyRemaining", "ftmoDailyHint",
    "ftmoMaxAdditionalRisk", "ftmoRiskHint", "ftmoDecisionText", "ftmoDecisionReason",
    "exitSuggestionBox",
    "journalMeta", "journalWinRate", "journalExpectancy", "journalBestPair",
    "journalBestPairHint", "journalBestSession", "journalBestSessionHint", "journalInsights",
    "bestHourLabel", "bestHourHint", "worstHourLabel", "worstHourHint",
    "bestSessionLabel", "bestSessionHint", "worstSessionLabel", "worstSessionHint",
    "topHoursList", "topSessionsList",
    "comboBestPair", "comboBestPairHint", "comboBestHour", "comboBestHourHint",
    "comboBestSession", "comboBestSessionHint", "comboScore", "comboScoreHint", "comboInsights",
    "topPriorityTrades", "topBlockedTrades",
    "onlyP1Btn", "autoFocusBtn", "entrySniperBtn", "exitSniperBtn",
    "activePriorityLabel", "activePriorityHint", "entryQualityLabel", "entryQualityHint",
    "exitQualityLabel", "exitQualityHint", "contextQualityLabel", "contextQualityHint"
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
      },
      ftmo: {
        ...defaultState.ftmo,
        ...(parsed.ftmo || {})
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
  if (els.strategyMode) els.strategyMode.value = appState.strategy;
  if (els.marketFilter) els.marketFilter.value = appState.marketFilter;
  if (els.pairSearch) els.pairSearch.value = appState.search;
  if (els.groqModel) els.groqModel.value = appState.aiSettings.model;
  if (els.aiMode) els.aiMode.value = appState.aiSettings.mode;
  if (els.macroCooldown) els.macroCooldown.value = appState.aiSettings.cooldownMinutes;
  if (els.maxRiskPerTrade) els.maxRiskPerTrade.value = "1";
  if (els.riskPercent) els.riskPercent.value = String(appState.ftmo.requestedRiskPercent || 1);
  updateOnlyP1Button();
  updateAutoFocusButton();
  updateEntrySniperButton();
  updateExitSniperButton();
}

function bindEvents() {
  els.strategyMode?.addEventListener("change", () => {
    appState.strategy = els.strategyMode.value;
    persistState();
    refreshAll(true);
  });

  els.marketFilter?.addEventListener("change", () => {
    appState.marketFilter = els.marketFilter.value;
    persistState();
    renderOverview();
    renderPairList();
  });

  els.pairSearch?.addEventListener("input", () => {
    appState.search = els.pairSearch.value.trim().toUpperCase();
    persistState();
    renderOverview();
    renderPairList();
  });

  els.refreshBtn?.addEventListener("click", () => refreshAll(true));
  els.recheckAiBtn?.addEventListener("click", () => refreshAll(true));

  els.tradeForm?.addEventListener("submit", onAddTrade);
  els.watchlistBtn?.addEventListener("click", toggleCurrentWatchlist);
  els.exportBtn?.addEventListener("click", exportTradesJson);
  els.clearTradesBtn?.addEventListener("click", clearTrades);

  els.settingsBtn?.addEventListener("click", () => {
    els.settingsModal?.classList.remove("hidden");
  });

  els.closeSettingsBtn?.addEventListener("click", () => {
    els.settingsModal?.classList.add("hidden");
  });

  els.saveSettingsBtn?.addEventListener("click", () => {
    appState.aiSettings.model = els.groqModel.value;
    appState.aiSettings.mode = els.aiMode.value;
    appState.aiSettings.cooldownMinutes = Number(els.macroCooldown.value) || 90;
    persistState();
    els.settingsModal?.classList.add("hidden");
    refreshAll(true);
  });

  els.riskPercent?.addEventListener("input", () => {
    fetchFtmoRisk();
  });

  els.onlyP1Btn?.addEventListener("click", () => {
    appState.onlyP1Mode = !appState.onlyP1Mode;
    persistState();
    updateOnlyP1Button();
    renderOverview();
    renderTopPriorityTrades();
    renderTopBlockedTrades();
    renderPairList();
  });

  els.autoFocusBtn?.addEventListener("click", () => {
    appState.autoFocusBestP1 = !appState.autoFocusBestP1;
    persistState();
    updateAutoFocusButton();
  });

  els.entrySniperBtn?.addEventListener("click", () => {
    appState.entrySniperMode = !appState.entrySniperMode;
    persistState();
    updateEntrySniperButton();
    refreshAll(true);
  });

  els.exitSniperBtn?.addEventListener("click", () => {
    appState.exitSniperMode = !appState.exitSniperMode;
    persistState();
    updateExitSniperButton();
    refreshAll(true);
  });
}

function setupChart() {
  if (!els.chart || !window.LightweightCharts) return;

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
    height: 300,
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
    if (chart && els.chart) {
      chart.applyOptions({ width: els.chart.clientWidth });
    }
  });
}

async function refreshAll(forceAi = false) {
  updateClockAndSession();

  const scans = await Promise.all(
    PAIRS.map((item) => scanPair(item, appState.timeframe, appState.strategy))
  );

  appState.scans = scans.sort((a, b) => {
    const aPriority = getDecisionPriority(a);
    const bPriority = getDecisionPriority(b);

    if (aPriority !== bPriority) return bPriority - aPriority;

    const aTier = PAIRS.find((p) => p.symbol === a.pair)?.tier ?? 3;
    const bTier = PAIRS.find((p) => p.symbol === b.pair)?.tier ?? 3;
    if (aTier !== bTier) return aTier - bTier;

    if ((b.finalScore ?? 0) !== (a.finalScore ?? 0)) {
      return (b.finalScore ?? 0) - (a.finalScore ?? 0);
    }

    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  await Promise.all(appState.scans.map(async (scan) => {
    const ml = await fetchMlScore(scan);
    scan.mlScore = ml.mlScore;
    scan.mlConfidenceBand = ml.confidenceBand;
    scan.mlExplanation = ml.explanation;
  }));

  appState.scans = appState.scans.map(applyMlScoreCap);

  appState.scans = appState.scans.sort((a, b) => {
    const aPriority = getDecisionPriority(a);
    const bPriority = getDecisionPriority(b);

    if (aPriority !== bPriority) return bPriority - aPriority;
    if ((b.finalScore ?? 0) !== (a.finalScore ?? 0)) return (b.finalScore ?? 0) - (a.finalScore ?? 0);
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  if (!appState.scans.some((scan) => scan.pair === appState.selectedPair)) {
    appState.selectedPair = appState.scans[0]?.pair || "EURUSD";
  }

  autoSelectBestP1();
  await fetchFtmoRisk();

  renderOverview();
  renderTopPriorityTrades();
  renderTopBlockedTrades();
  renderPairList();
  renderSelectedPair();
  renderTrades();
  renderWatchlist();
  await fetchJournalInsights();
  persistState();

  await refreshAiDecision(forceAi);
}

function updateClockAndSession() {
  const now = new Date();
  const session = getMarketSession(now);
  const risk = getGlobalRiskSnapshot();

  if (els.localClock) {
    els.localClock.textContent = now.toLocaleString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      day: "2-digit",
      month: "2-digit"
    });
  }

  if (els.activeSessionPill) els.activeSessionPill.textContent = session.label;
  if (els.riskPill) els.riskPill.textContent = risk.label;
  if (els.marketBiasPill) els.marketBiasPill.textContent = session.biasLabel;
  if (els.sessionHeadline) els.sessionHeadline.textContent = session.headline;
  if (els.sessionSubline) els.sessionSubline.textContent = risk.description;
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
  const macdLine = Number(market.indicators?.macd ?? (ema(closes, 12) - ema(closes, 26)));
  const momentum = Number(
    market.indicators?.momentum ??
    (((current - closes.at(-12)) / closes.at(-12)) * 100)
  );

  const support = Math.min(...lows.slice(-20));
  const resistance = Math.max(...highs.slice(-20));
  const sessionBoost = getSessionBoost(item.symbol);
  const macroPenalty = estimateMacroPenalty(item.symbol);
  const structureBias = detectStructure(highs, lows);
  const candleBias = detectLastCandleSignal(candles);
  const historicalEdge = historicalSimilarity(item.symbol, timeframe, rsi14, momentum, atr14);
  const correlationPenalty = getCorrelationPenalty(item.symbol);
  const spreadPenalty = getSpreadPenalty(item.symbol, atr14);
  const offSessionPenalty = getOffSessionPenalty(item.symbol);
  const tierBonus = item.tier === 1 ? 6 : item.tier === 2 ? 2 : -2;
  const journalLocalBonus = computeJournalLocalBonus(item.symbol);
  const timeSessionContext = computeTimeSessionLocalBonus();
  const premiumComboBonus = computePremiumComboBonus(item.symbol);
  const hardBlockLocal = computeHardBlockLocalPenalty(item.symbol);
  const combinedMacroPenaltyBoost = hardBlockLocal.blocked && macroPenalty >= 4 ? 12 : 0;

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
  riskScore -= combinedMacroPenaltyBoost;

  let contextScore = 50;
  contextScore += sessionBoost;
  contextScore += historicalEdge;
  contextScore += tierBonus;
  contextScore += journalLocalBonus;
  contextScore += timeSessionContext.bonus;
  contextScore += premiumComboBonus;
  contextScore -= hardBlockLocal.penalty;
  contextScore += strategyBonus(strategy, {
    rsi14,
    current,
    support,
    resistance,
    ema20,
    ema50
  });

  const rawFinalScore = clamp(
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
    finalScore: rawFinalScore,
    atr14,
    current
  });

  if (hardBlockLocal.blocked) {
    gatekeeper.allowed = false;
    gatekeeper.decision = "NO TRADE";
    gatekeeper.checks.push({
      label: "Journal local",
      ok: false,
      value: "Contexte faible"
    });
  }

  const tempRr = Math.abs(((current + atr14 * 2.6) - current) / ((current - (current - atr14 * 1.4)) || 1));

  const entryTriggerScore = computeEntryTriggerScore({
    timingScore: clamp(Math.round(timingScore), 1, 99),
    trendScore: clamp(Math.round(trendScore), 1, 99),
    riskScore: clamp(Math.round(riskScore), 1, 99),
    contextScore: clamp(Math.round(contextScore), 1, 99),
    rr: tempRr.toFixed(2),
    macroPenalty,
    spreadPenalty,
    offSessionPenalty,
    rsi14,
    macdLine
  });

  const entrySniper = computeEntrySniper({
    current,
    resistance,
    support,
    momentum,
    trendScore: clamp(Math.round(trendScore), 1, 99),
    timingScore: clamp(Math.round(timingScore), 1, 99),
    riskScore: clamp(Math.round(riskScore), 1, 99),
    rr: tempRr.toFixed(2),
    entryTriggerScore,
    rsi14,
    macdLine
  });

  if (appState.entrySniperMode && entrySniper.blocked) {
    gatekeeper.allowed = false;
    gatekeeper.decision = "NO TRADE";
    gatekeeper.checks.push({
      label: "Entry sniper",
      ok: false,
      value: "Alignement insuffisant"
    });
  }

  const aiDecision = appState.aiDecisionCache[item.symbol] || null;
  const finalScore = applyFinalScoreCap({
    rawFinalScore,
    gatekeeperDecision: gatekeeper.decision,
    hardBlockLocal,
    macroPenalty,
    aiDecision
  });

  const signal = gatekeeper.allowed
    ? finalScore >= 82 ? "STRONG BUY"
      : finalScore >= 68 ? "BUY"
      : finalScore <= 22 ? "STRONG SELL"
      : finalScore <= 36 ? "SELL"
      : "WAIT"
    : gatekeeper.decision;

  const direction = signal.includes("SELL") ? "sell" : "buy";
  const stopLoss = direction === "buy" ? current - atr14 * 1.4 : current + atr14 * 1.4;
  const takeProfit = direction === "buy" ? current + atr14 * 2.6 : current - atr14 * 2.6;
  const rr = Math.abs((takeProfit - current) / ((current - stopLoss) || 1));
  const confidence = clamp(Math.round(finalScore * 0.72 + Math.max(0, riskScore) * 0.28), 1, 99);

  const exitSniper = computeExitSniper({
    rr: rr.toFixed(2),
    momentum,
    trendScore: clamp(Math.round(trendScore), 1, 99),
    timingScore: clamp(Math.round(timingScore), 1, 99),
    riskScore: clamp(Math.round(riskScore), 1, 99)
  }, aiDecision);

  const priority = getDecisionPriority({
    pair: item.symbol,
    gatekeeper,
    finalScore,
    confidence,
    blocked: false
  });

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
    macdLine,
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
    rawFinalScore,
    finalScore,
    gatekeeper,
    signal,
    direction,
    stopLoss,
    takeProfit,
    rr: rr.toFixed(2),
    confidence,
    trend: ema20 > ema50 ? "Bullish" : "Bearish",
    priority,
    entryTriggerScore,
    entrySniper,
    exitSniper,
    mlScore: 0,
    mlConfidenceBand: "medium",
    mlExplanation: "",
    reasons: buildReasons({
      ema20,
      ema50,
      rsi14,
      momentum,
      structureBias,
      macroPenalty,
      correlationPenalty,
      spreadPenalty,
      gatekeeper,
      tier: item.tier,
      journalBonus: journalLocalBonus,
      hourExpectancy: timeSessionContext.hourExpectancy,
      sessionExpectancy: timeSessionContext.sessionExpectancy,
      premiumComboBonus,
      hardBlockReason: hardBlockLocal.blocked ? hardBlockLocal.reason : "",
      combinedRiskReason: hardBlockLocal.blocked && macroPenalty >= 4
        ? "Le contexte local faible est aggravé par un risque macro déjà présent."
        : "",
      rawFinalScore,
      finalScore,
      priorityLabel: priority === 3 ? "P1" : priority === 2 ? "P2" : "P3",
      entrySniperReason: entrySniper.reason,
      entrySniperScore: entrySniper.score,
      exitSniperReason: exitSniper.reason,
      exitSniperAction: exitSniper.action,
      exitSniperScore: exitSniper.score,
      mlScore: 0,
      mlExplanation: ""
    })
  };
}

async function fetchMlScore(scan) {
  try {
    const journalContext = buildJournalContextForPair(scan) || {};

    const response = await fetch("/api/ml-score", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        pair: scan.pair,
        timeframe: scan.timeframe,
        trendScore: scan.trendScore,
        timingScore: scan.timingScore,
        riskScore: scan.riskScore,
        contextScore: scan.contextScore,
        entryTriggerScore: scan.entryTriggerScore,
        entrySniperScore: scan.entrySniper?.score || 0,
        exitSniperScore: scan.exitSniper?.score || 0,
        rsi14: scan.rsi14,
        macdLine: scan.macdLine,
        atr14: scan.atr14,
        momentum: scan.momentum,
        rr: scan.rr,
        macroPenalty: scan.macroPenalty,
        spreadPenalty: scan.spreadPenalty,
        offSessionPenalty: scan.offSessionPenalty,
        pairExpectancy: journalContext.pairExpectancy || 0,
        hourExpectancy: journalContext.hourExpectancy || 0,
        sessionExpectancy: journalContext.sessionExpectancy || 0,
        pairWinRate: journalContext.pairWinRate || 0,
        hourWinRate: journalContext.hourWinRate || 0,
        sessionWinRate: journalContext.sessionWinRate || 0
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
          scan.riskScore * 0.2 +
          scan.contextScore * 0.14 +
          (scan.entryTriggerScore || 0) * 0.18
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

function applyMlScoreCap(scan) {
  const mlScore = Number(scan.mlScore || 0);

  if (mlScore <= 35) {
    scan.finalScore = Math.min(scan.finalScore, 22);
  } else if (mlScore <= 50) {
    scan.finalScore = Math.min(scan.finalScore, 38);
  } else if (mlScore <= 60) {
    scan.finalScore = Math.min(scan.finalScore, 55);
  }

  if (mlScore <= 35) {
    scan.gatekeeper.allowed = false;
    scan.gatekeeper.decision = "NO TRADE";
  } else if (mlScore <= 50 && scan.gatekeeper.decision === "TRADE") {
    scan.gatekeeper.allowed = false;
    scan.gatekeeper.decision = "WAIT";
  }

  return scan;
}

function renderOverview() {
  const filtered = getFilteredScans();

  if (!filtered.length && appState.onlyP1Mode) {
    if (els.topPairLabel) els.topPairLabel.textContent = "Aucun P1";
    if (els.topPairReason) els.topPairReason.textContent = "Aucune opportunité premium pour le moment";
  }

  const best = [...filtered].sort((a, b) => {
    const aPriority = getDecisionPriority(a);
    const bPriority = getDecisionPriority(b);
    if (aPriority !== bPriority) return bPriority - aPriority;
    return (b.finalScore ?? 0) - (a.finalScore ?? 0);
  })[0];

  const allowed = filtered.filter((s) => s.gatekeeper.decision === "TRADE").length;
  const blocked = filtered.filter((s) => s.gatekeeper.decision === "NO TRADE").length;
  const exposure = calculateOpenExposure();

  if (els.topPairLabel) els.topPairLabel.textContent = best ? `${best.pair} · ${best.signal}` : "--";
  if (els.topPairReason) els.topPairReason.textContent = best ? `${best.trend} · confiance ${best.confidence}` : "--";

  const topPairLabelCard = document.getElementById("topPairLabelCard");
  const topPairReasonCard = document.getElementById("topPairReasonCard");
  if (topPairLabelCard) topPairLabelCard.textContent = best ? `${best.pair} · ${best.signal}` : "--";
  if (topPairReasonCard) topPairReasonCard.textContent = best ? `${best.trend} · confiance ${best.confidence}` : "--";

  if (els.allowedCount) els.allowedCount.textContent = String(allowed);
  if (els.blockedCount) els.blockedCount.textContent = String(blocked);
  if (els.globalExposure) els.globalExposure.textContent = `${exposure.toFixed(2)}%`;
  if (els.bestScore) els.bestScore.textContent = best?.finalScore ?? "--";
}

function getFilteredScans() {
  let list = [...appState.scans];

  if (appState.marketFilter !== "all") {
    list = list.filter((scan) => scan.group === appState.marketFilter);
  }

  if (appState.search) {
    list = list.filter((scan) => scan.pair.includes(appState.search));
  }

  if (appState.onlyP1Mode) {
    list = list.filter((scan) => getDecisionPriority(scan) === 3);
  }

  return list;
}

function renderTopPriorityTrades() {
  if (!els.topPriorityTrades) return;

  const sourceList = appState.onlyP1Mode
    ? [...appState.scans].filter((scan) => getDecisionPriority(scan) === 3)
    : [...appState.scans];

  const list = sourceList
    .sort((a, b) => {
      const aPriority = getDecisionPriority(a);
      const bPriority = getDecisionPriority(b);
      if (aPriority !== bPriority) return bPriority - aPriority;
      if ((b.finalScore ?? 0) !== (a.finalScore ?? 0)) return (b.finalScore ?? 0) - (a.finalScore ?? 0);
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    })
    .slice(0, 3);

  if (!list.length) {
    els.topPriorityTrades.innerHTML = `<div class="muted">Aucune opportunité pour le moment.</div>`;
    return;
  }

  els.topPriorityTrades.innerHTML = list.map((scan) => {
    const priority = getDecisionPriority(scan);
    const ai = appState.aiDecisionCache[scan.pair];
    const decision = ai?.decision || scan.gatekeeper?.decision || "WAIT";
    const priorityLabel = priority === 3 ? "P1" : priority === 2 ? "P2" : "P3";
    const signalClass = decision === "TRADE" ? "signal-buy" : decision === "WAIT" ? "signal-wait" : "signal-sell";

    return `
      <button class="pair-item" data-priority-open="${scan.pair}">
        <div class="pair-left">
          <div class="pair-title-row">
            <span class="pair-symbol">${scan.pair}</span>
            <span class="signal-badge ${signalClass}">${priorityLabel}</span>
            <span class="signal-badge ${signalClass}">${decision}</span>
          </div>
          <div class="pair-meta">
            <span class="tag">${scan.trend}</span>
            <span class="tag">Score ${scan.finalScore}</span>
            <span class="tag">ML ${scan.mlScore ?? "--"}</span>
            <span class="tag">Conf ${scan.confidence}</span>
            <span class="tag">RR ${scan.rr}</span>
          </div>
        </div>
        <div class="score-badge ${scan.finalScore >= 70 ? "good" : scan.finalScore <= 35 ? "bad" : ""}">
          ${scan.finalScore}
        </div>
      </button>
    `;
  }).join("");

  list.forEach((scan) => {
    const btn = els.topPriorityTrades.querySelector(`[data-priority-open="${scan.pair}"]`);
    btn?.addEventListener("click", () => {
      appState.selectedPair = scan.pair;
      persistState();
      renderSelectedPair();
      refreshAiDecision(true);
    });
  });
}

function renderTopBlockedTrades() {
  if (!els.topBlockedTrades) return;

  const list = [...appState.scans]
    .filter((scan) => {
      const ai = appState.aiDecisionCache[scan.pair];
      const combined = computeCombinedRiskBlock(scan.pair);
      const decision = ai?.decision || scan.gatekeeper?.decision || "WAIT";
      return combined.blocked || decision === "NO TRADE" || scan.gatekeeper?.decision === "NO TRADE";
    })
    .sort((a, b) => {
      const aCombined = computeCombinedRiskBlock(a.pair);
      const bCombined = computeCombinedRiskBlock(b.pair);
      if (aCombined.blocked !== bCombined.blocked) return aCombined.blocked ? -1 : 1;
      return (a.finalScore ?? 0) - (b.finalScore ?? 0);
    })
    .slice(0, 3);

  if (!list.length) {
    els.topBlockedTrades.innerHTML = `<div class="muted">Aucun blocage majeur pour le moment.</div>`;
    return;
  }

  els.topBlockedTrades.innerHTML = list.map((scan) => {
    const combined = computeCombinedRiskBlock(scan.pair);
    const reason = combined.blocked
      ? combined.reason
      : scan.reasons?.find((x) => {
          const s = x.toLowerCase();
          return s.includes("bloqué") || s.includes("défavorable") || s.includes("faible") || s.includes("macro");
        }) || "Contexte insuffisant.";

    return `
      <button class="pair-item" data-blocked-open="${scan.pair}">
        <div class="pair-left">
          <div class="pair-title-row">
            <span class="pair-symbol">${scan.pair}</span>
            <span class="signal-badge signal-sell">NO TRADE</span>
          </div>
          <div class="pair-meta">
            <span class="tag">${scan.trend}</span>
            <span class="tag">Score ${scan.finalScore}</span>
            <span class="tag">ML ${scan.mlScore ?? "--"}</span>
            <span class="tag">Conf ${scan.confidence}</span>
          </div>
          <div class="muted small" style="margin-top:8px;">${reason}</div>
        </div>
        <div class="score-badge bad">${scan.finalScore}</div>
      </button>
    `;
  }).join("");

  list.forEach((scan) => {
    const btn = els.topBlockedTrades.querySelector(`[data-blocked-open="${scan.pair}"]`);
    btn?.addEventListener("click", () => {
      appState.selectedPair = scan.pair;
      persistState();
      renderSelectedPair();
      refreshAiDecision(true);
    });
  });
}

function renderPairList() {
  const list = getFilteredScans();

  if (!list.length && appState.onlyP1Mode) {
    if (els.pairCount) els.pairCount.textContent = "0 paire(s)";
    if (els.pairList) els.pairList.innerHTML = `<div class="muted">Aucune opportunité P1 pour le moment.</div>`;
    return;
  }

  if (els.pairCount) els.pairCount.textContent = `${list.length} paire(s)`;
  if (!els.pairList) return;
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

    const priority = getDecisionPriority(scan);
    const priorityLabel = priority === 3 ? "P1" : priority === 2 ? "P2" : "P3";
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
          <span class="tag">${priorityLabel}</span>
          <span class="tag">${scan.trend}</span>
          <span class="tag">ML ${scan.mlScore ?? "--"}</span>
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
  const hardBlockCombined = computeCombinedRiskBlock(scan.pair);
  const priority = getDecisionPriority(scan);
  const priorityLabel = priority === 3 ? "P1" : priority === 2 ? "P2" : "P3";
  const timeSessionContext = computeTimeSessionLocalBonus();

  if (els.selectedPairName) els.selectedPairName.textContent = scan.pair;
  if (els.selectedSignalBadge) {
    els.selectedSignalBadge.textContent = hardBlockCombined.blocked ? "NO TRADE" : (ai?.decision || scan.gatekeeper.decision);
  }

  if (els.tradePair) els.tradePair.value = scan.pair;
  if (els.tradeDirection) els.tradeDirection.value = scan.direction;

  if (els.summaryMetrics) {
    els.summaryMetrics.innerHTML = [
      metricCard("Prix", formatPrice(scan.current), scan.trend),
      metricCard("Trend", `${scan.trendScore}`, "force directionnelle"),
      metricCard("Timing", `${scan.timingScore}`, "qualité d’entrée"),
      metricCard("Entry", `${scan.entryTriggerScore}`, "trigger entrée"),
      metricCard("Sniper", `${scan.entrySniper?.score ?? "--"}`, scan.entrySniper?.quality || "entry filter"),
      metricCard("Exit", `${scan.exitSniper?.score ?? "--"}`, scan.exitSniper?.action || "exit filter"),
      metricCard("ML", `${scan.mlScore ?? "--"}`, scan.mlConfidenceBand || "model"),
      metricCard("RSI", `${Math.round(scan.rsi14)}`, "zone entrée"),
      metricCard("MACD", `${Number(scan.macdLine).toFixed(3)}`, "momentum"),
      metricCard("Risk", `${scan.riskScore}`, "macro, spread, corrélation"),
      metricCard("Context", `${scan.contextScore}`, "session + historique"),
      metricCard("Score", `${scan.finalScore}`, `brut ${scan.rawFinalScore ?? scan.finalScore}`),
      metricCard("Source", scan.marketSource || "--", "marché live / fallback")
    ].join("");
  }

  if (els.trendMini) els.trendMini.textContent = scan.trend;
  if (els.confidenceMini) els.confidenceMini.textContent = `${ai?.confidence ?? scan.confidence}%`;
  if (els.rrMini) els.rrMini.textContent = scan.rr;
  if (els.aiMini) {
    els.aiMini.textContent = `${ai?.decision || "--"} · ${priorityLabel}`;
    if (timeSessionContext.bonus > 0) els.aiMini.textContent += " ↑";
    else if (timeSessionContext.bonus < 0) els.aiMini.textContent += " ↓";
  }

  if (els.reasonList) els.reasonList.innerHTML = scan.reasons.map((reason) => `<li>${reason}</li>`).join("");
  if (els.gatekeeperBox) {
    els.gatekeeperBox.innerHTML = scan.gatekeeper.checks.map((check) => `
      <div class="gate-row">
        <span>${check.label}</span>
        <strong class="${check.ok ? "gate-ok" : check.value === "Faible liquidité" ? "gate-warn" : "gate-bad"}">
          ${check.value}
        </strong>
      </div>
    `).join("");
  }

  renderTradeSuggestion(scan, ai);
  renderChart(scan.candles);
  fetchExitSuggestion(scan, ai);
  renderProfessionalStatus(scan, ai);
}

function renderTradeSuggestion(scan, ai) {
  const decision = ai?.decision || scan.gatekeeper.decision;
  const confidence = ai?.confidence ?? scan.confidence;
  const explanation = ai?.reason || "Le moteur privilégie prudence et sélection stricte.";
  const hardBlockLocal = computeHardBlockLocalPenalty(scan.pair);
  const hardBlockCombined = computeCombinedRiskBlock(scan.pair);

  const entryQuality =
    scan.entryTriggerScore >= 80 ? "Entrée premium" :
    scan.entryTriggerScore >= 65 ? "Entrée correcte" :
    scan.entryTriggerScore >= 50 ? "Entrée moyenne" :
    "Entrée faible";

  const sniperReason = scan.entrySniper?.reason || "Pas de lecture sniper.";
  const mlRead =
    scan.mlScore >= 80 ? "ML très favorable" :
    scan.mlScore >= 65 ? "ML favorable" :
    scan.mlScore >= 50 ? "ML neutre" :
    "ML défavorable";

  if (!els.tradeSuggestionBox) return;

  els.tradeSuggestionBox.innerHTML = `
    <strong>${hardBlockCombined.blocked ? "NO TRADE" : hardBlockLocal.blocked ? "NO TRADE" : decision}</strong><br/>
    ${hardBlockCombined.blocked ? `Blocage combiné : ${hardBlockCombined.reason}<br/>` : ""}
    ${!hardBlockCombined.blocked && hardBlockLocal.blocked ? `Blocage local : ${hardBlockLocal.reason}<br/>` : ""}
    Confiance : ${confidence}%<br/>
    Lecture ML : ${mlRead} (${scan.mlScore ?? "--"})<br/>
    Qualité d'entrée : ${entryQuality}<br/>
    Mode sniper : ${scan.entrySniper?.quality || "--"} (${scan.entrySniper?.score ?? "--"})<br/>
    Lecture sniper : ${sniperReason}<br/>
    Direction suggérée : ${scan.direction.toUpperCase()}<br/>
    Entrée repère : ${formatPrice(scan.current)}<br/>
    Stop loss : ${formatPrice(scan.stopLoss)}<br/>
    Take profit : ${formatPrice(scan.takeProfit)}<br/>
    Ratio RR : ${scan.rr}<br/>
    Exit dynamique : break-even à 1R, sortie partielle à 1.5R, trailing ATR au-delà.<br/>
    Motif principal : ${explanation}
  `;
}

function renderChart(candles) {
  if (!candleSeries || !chart) return;

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

function metricCard(label, value, hint) {
  return `
    <article class="metric-card">
      <span class="muted">${label}</span>
      <strong>${value}</strong>
      <small>${hint}</small>
    </article>
  `;
}

function renderWatchlist() {
  if (!els.watchlist) return;

  els.watchlist.innerHTML = "";
  if (els.watchlistCount) els.watchlistCount.textContent = `${appState.watchlist.length} actif(s)`;

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

    card.querySelector(`[data-open="${scan.pair}"]`)?.addEventListener("click", () => {
      appState.selectedPair = scan.pair;
      persistState();
      renderSelectedPair();
      refreshAiDecision(true);
    });

    card.querySelector(`[data-remove="${scan.pair}"]`)?.addEventListener("click", () => {
      appState.watchlist = appState.watchlist.filter((p) => p !== scan.pair);
      persistState();
      renderWatchlist();
    });

    els.watchlist.appendChild(card);
  });
}

function renderTrades() {
  if (!els.tradeList) return;

  els.tradeList.innerHTML = "";
  if (els.tradeStats) els.tradeStats.textContent = `${appState.trades.length} trade(s)`;

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

    card.querySelector(`[data-close="${trade.id}"]`)?.addEventListener("click", () => {
      const target = appState.trades.find((t) => t.id === trade.id);
      if (target) {
        target.status = "archivé";
        persistState();
        renderTrades();
        renderOverview();
      }
    });

    card.querySelector(`[data-delete="${trade.id}"]`)?.addEventListener("click", () => {
      appState.trades = appState.trades.filter((t) => t.id !== trade.id);
      persistState();
      renderTrades();
      renderOverview();
      fetchFtmoRisk();
      fetchJournalInsights();
    });

    els.tradeList.appendChild(card);
  });
}

async function refreshAiDecision(force = false) {
  const selectedScan = appState.scans.find((s) => s.pair === appState.selectedPair) || appState.scans[0];
  if (!selectedScan) return;

  if (els.decisionAsset) els.decisionAsset.textContent = selectedScan.pair;

  const cacheKey = [
    selectedScan.pair,
    selectedScan.finalScore,
    selectedScan.gatekeeper.decision,
    appState.aiSettings.mode,
    appState.aiSettings.model,
    appState.aiSettings.cooldownMinutes,
    selectedScan.mlScore
  ].join("_");

  if (!force && appState.aiDecisionCache[selectedScan.pair]?.cacheKey === cacheKey) {
    applyDecisionUi(selectedScan.pair, appState.aiDecisionCache[selectedScan.pair]);
    renderSelectedPair();
    renderPairList();
    renderTopPriorityTrades();
    renderTopBlockedTrades();
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
  renderTopPriorityTrades();
  renderTopBlockedTrades();
}

function applyDecisionUi(pair, decision) {
  if (els.decisionAsset) els.decisionAsset.textContent = pair;
  if (els.decisionBadge) els.decisionBadge.textContent = decision.decision;
  if (els.decisionText) els.decisionText.textContent = decision.title;
  if (els.decisionReason) els.decisionReason.textContent = decision.reason;
  if (els.decisionConfidence) els.decisionConfidence.textContent = `${decision.confidence}%`;
  if (els.decisionRiskMode) els.decisionRiskMode.textContent = `Mode ${appState.aiSettings.mode}`;
  if (els.decisionAction) els.decisionAction.textContent = decision.action;
  if (els.decisionWindow) els.decisionWindow.textContent = decision.window;
}

async function askServerForDecision(scan) {
  const journalContext = buildJournalContextForPair(scan);

  const response = await fetch("/api/ai-decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
      cooldownMinutes: appState.aiSettings.cooldownMinutes,
      journalContext,
      mlScore: scan.mlScore || 0,
      mlConfidenceBand: scan.mlConfidenceBand || "medium",
      mlExplanation: scan.mlExplanation || ""
    })
  });

  if (!response.ok) throw new Error(`AI endpoint error ${response.status}`);

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
        headers: { Accept: "application/json" }
      }
    );

    if (!res.ok) throw new Error(`market-data ${res.status}`);

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

async function fetchFtmoRisk() {
  try {
    const openRiskPercent = calculateOpenExposure();
    const requestedRiskPercent = Number(els.riskPercent?.value || appState.ftmo.requestedRiskPercent || 1);

    appState.ftmo.openRiskPercent = openRiskPercent;
    appState.ftmo.requestedRiskPercent = requestedRiskPercent;

    const response = await fetch("/api/risk-engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountSize: appState.ftmo.accountSize,
        dailyLossLimitPercent: appState.ftmo.dailyLossLimitPercent,
        totalLossLimitPercent: appState.ftmo.totalLossLimitPercent,
        openRiskPercent: appState.ftmo.openRiskPercent,
        closedTodayPnl: appState.ftmo.closedTodayPnl,
        floatingPnl: appState.ftmo.floatingPnl,
        requestedRiskPercent: appState.ftmo.requestedRiskPercent
      })
    });

    if (!response.ok) throw new Error(`risk-engine ${response.status}`);

    const data = await response.json();
    appState.ftmoRiskResult = data;
    persistState();
    renderFtmoRiskPanel();
    return data;
  } catch {
    appState.ftmoRiskResult = {
      ok: false,
      decision: "WAIT",
      reason: "Impossible de vérifier le risque pour le moment.",
      remainingDailyLoss: 0,
      maxAdditionalRiskPercent: 0
    };
    renderFtmoRiskPanel();
    return appState.ftmoRiskResult;
  }
}

function renderFtmoRiskPanel() {
  const risk = appState.ftmoRiskResult;

  if (!risk) {
    if (els.ftmoRiskTitle) els.ftmoRiskTitle.textContent = "Statut risque";
    if (els.ftmoDecisionBadge) {
      els.ftmoDecisionBadge.textContent = "WAIT";
      els.ftmoDecisionBadge.className = "signal-badge signal-wait";
    }
    if (els.ftmoDailyRemaining) els.ftmoDailyRemaining.textContent = "--";
    if (els.ftmoDailyHint) els.ftmoDailyHint.textContent = "Limite journalière";
    if (els.ftmoMaxAdditionalRisk) els.ftmoMaxAdditionalRisk.textContent = "--";
    if (els.ftmoRiskHint) els.ftmoRiskHint.textContent = "Risque encore autorisé";
    if (els.ftmoDecisionText) els.ftmoDecisionText.textContent = "Analyse en cours";
    if (els.ftmoDecisionReason) els.ftmoDecisionReason.textContent = "Le moteur vérifie les limites de risque.";
    return;
  }

  const allowed = risk.allowed === true;
  const blocked = risk.decision === "TRADE BLOCKED";

  if (els.ftmoRiskTitle) els.ftmoRiskTitle.textContent = "Contrôle FTMO actif";
  if (els.ftmoDecisionBadge) {
    els.ftmoDecisionBadge.textContent = allowed ? "ALLOWED" : blocked ? "BLOCKED" : "WAIT";
    els.ftmoDecisionBadge.className = `signal-badge ${allowed ? "signal-buy" : blocked ? "signal-sell" : "signal-wait"}`;
  }
  if (els.ftmoDailyRemaining) els.ftmoDailyRemaining.textContent = `${Number(risk.remainingDailyLoss || 0).toFixed(2)}$`;
  if (els.ftmoDailyHint) els.ftmoDailyHint.textContent = `Limite: ${Number(risk.dailyLossLimitValue || 0).toFixed(2)}$`;
  if (els.ftmoMaxAdditionalRisk) els.ftmoMaxAdditionalRisk.textContent = `${Number(risk.maxAdditionalRiskPercent || 0).toFixed(2)}%`;
  if (els.ftmoRiskHint) els.ftmoRiskHint.textContent = `Risque demandé: ${Number(risk.requestedRiskValue || 0).toFixed(2)}$`;
  if (els.ftmoDecisionText) els.ftmoDecisionText.textContent = risk.decision || "WAIT";
  if (els.ftmoDecisionReason) els.ftmoDecisionReason.textContent = risk.reason || "Le moteur reste prudent.";
}

async function fetchExitSuggestion(scan, aiDecision) {
  try {
    const entry = Number(els.tradeEntry.value || scan.current);
    const localExitSniper = scan.exitSniper || null;

    const response = await fetch("/api/exit-engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pair: scan.pair,
        direction: scan.direction,
        entry,
        currentPrice: scan.current,
        stopLoss: scan.stopLoss,
        takeProfit: scan.takeProfit,
        atr14: scan.atr14,
        macroDanger: aiDecision?.decision === "NO TRADE",
        momentum: scan.momentum,
        confidence: aiDecision?.confidence || scan.confidence
      })
    });

    if (!response.ok) throw new Error(`exit-engine ${response.status}`);

    const data = await response.json();

    if (els.exitSuggestionBox) {
      els.exitSuggestionBox.innerHTML = `
        <strong>${data.decision}</strong><br/>
        Exit sniper : ${localExitSniper?.quality || "--"} (${localExitSniper?.score ?? "--"})<br/>
        Action sniper : ${localExitSniper?.action || "--"}<br/>
        Lecture sniper : ${localExitSniper?.reason || "--"}<br/>
        R multiple : ${data.rMultiple}<br/>
        Progression TP : ${data.tpProgress}<br/>
        Sortie partielle : ${data.partialClosePercent}%<br/>
        Nouveau stop : ${data.newStopLoss}<br/>
        Motif : ${data.reason}
      `;
    }
  } catch {
    if (els.exitSuggestionBox) {
      els.exitSuggestionBox.innerHTML = `
        <strong>EXIT ENGINE INDISPONIBLE</strong><br/>
        Impossible de calculer la meilleure sortie pour le moment.
      `;
    }
  }
}

async function fetchJournalInsights() {
  try {
    const payloadTrades = appState.trades.map((trade) => {
      const scan = appState.scans.find((s) => s.pair === trade.pair);
      return {
        ...trade,
        currentPrice: scan?.current ?? Number(trade.entry),
        exitPrice: scan?.current ?? Number(trade.entry)
      };
    });

    const response = await fetch("/api/journal-insights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trades: payloadTrades })
    });

    if (!response.ok) throw new Error(`journal-insights ${response.status}`);

    const data = await response.json();
    appState.journal = data;
    persistState();
    renderJournalInsights();
    return data;
  } catch {
    appState.journal = null;
    renderJournalInsights();
    return null;
  }
}

function renderJournalInsights() {
  const j = appState.journal;

  if (!j) {
    if (els.journalMeta) els.journalMeta.textContent = "--";
    if (els.journalWinRate) els.journalWinRate.textContent = "--";
    if (els.journalExpectancy) els.journalExpectancy.textContent = "--";
    if (els.journalBestPair) els.journalBestPair.textContent = "--";
    if (els.journalBestPairHint) els.journalBestPairHint.textContent = "--";
    if (els.journalBestSession) els.journalBestSession.textContent = "--";
    if (els.journalBestSessionHint) els.journalBestSessionHint.textContent = "--";
    if (els.journalInsights) els.journalInsights.innerHTML = `<li>Pas assez de données pour analyser ton journal.</li>`;
    renderTimeEdgePanel();
    renderPremiumCombo();
    return;
  }

  if (els.journalMeta) els.journalMeta.textContent = `${j.totalTrades || 0} trade(s) analysé(s)`;
  if (els.journalWinRate) els.journalWinRate.textContent = `${Number(j.winRate || 0).toFixed(2)}%`;
  if (els.journalExpectancy) els.journalExpectancy.textContent = Number(j.expectancy || 0).toFixed(4);
  if (els.journalBestPair) els.journalBestPair.textContent = j.bestPair?.key || "--";
  if (els.journalBestPairHint) els.journalBestPairHint.textContent = j.bestPair ? `Expectancy ${j.bestPair.expectancy}` : "--";
  if (els.journalBestSession) els.journalBestSession.textContent = j.bestSession?.key || "--";
  if (els.journalBestSessionHint) els.journalBestSessionHint.textContent = j.bestSession ? `Win rate ${j.bestSession.winRate}%` : "--";
  if (els.journalInsights) {
    els.journalInsights.innerHTML = (j.insights?.length
      ? j.insights.map((x) => `<li>${x}</li>`).join("")
      : `<li>Pas assez d’insights pour le moment.</li>`);
  }

  renderTimeEdgePanel();
  renderPremiumCombo();
}

function renderTimeEdgePanel() {
  const journal = appState.journal;

  if (!journal) {
    if (els.bestHourLabel) els.bestHourLabel.textContent = "--";
    if (els.bestHourHint) els.bestHourHint.textContent = "--";
    if (els.worstHourLabel) els.worstHourLabel.textContent = "--";
    if (els.worstHourHint) els.worstHourHint.textContent = "--";
    if (els.bestSessionLabel) els.bestSessionLabel.textContent = "--";
    if (els.bestSessionHint) els.bestSessionHint.textContent = "--";
    if (els.worstSessionLabel) els.worstSessionLabel.textContent = "--";
    if (els.worstSessionHint) els.worstSessionHint.textContent = "--";
    if (els.topHoursList) els.topHoursList.innerHTML = `<div class="muted">Pas assez de données.</div>`;
    if (els.topSessionsList) els.topSessionsList.innerHTML = `<div class="muted">Pas assez de données.</div>`;
    return;
  }

  const bestHour = journal.bestHour || null;
  const worstHour = journal.worstHour || null;
  const bestSession = journal.bestSession || null;
  const worstSession = journal.worstSession || null;

  if (els.bestHourLabel) els.bestHourLabel.textContent = bestHour ? `${bestHour.key}h` : "--";
  if (els.bestHourHint) {
    els.bestHourHint.textContent = bestHour
      ? `WR ${Number(bestHour.winRate || 0).toFixed(2)}% · Exp ${Number(bestHour.expectancy || 0).toFixed(4)}`
      : "--";
  }

  if (els.worstHourLabel) els.worstHourLabel.textContent = worstHour ? `${worstHour.key}h` : "--";
  if (els.worstHourHint) {
    els.worstHourHint.textContent = worstHour
      ? `WR ${Number(worstHour.winRate || 0).toFixed(2)}% · Exp ${Number(worstHour.expectancy || 0).toFixed(4)}`
      : "--";
  }

  if (els.bestSessionLabel) els.bestSessionLabel.textContent = bestSession?.key || "--";
  if (els.bestSessionHint) {
    els.bestSessionHint.textContent = bestSession
      ? `WR ${Number(bestSession.winRate || 0).toFixed(2)}% · Exp ${Number(bestSession.expectancy || 0).toFixed(4)}`
      : "--";
  }

  if (els.worstSessionLabel) els.worstSessionLabel.textContent = worstSession?.key || "--";
  if (els.worstSessionHint) {
    els.worstSessionHint.textContent = worstSession
      ? `WR ${Number(worstSession.winRate || 0).toFixed(2)}% · Exp ${Number(worstSession.expectancy || 0).toFixed(4)}`
      : "--";
  }

  const topHours = Array.isArray(journal.hourStats)
    ? [...journal.hourStats].sort((a, b) => Number(b.expectancy || 0) - Number(a.expectancy || 0)).slice(0, 4)
    : [];

  const topSessions = Array.isArray(journal.sessionStats)
    ? [...journal.sessionStats].sort((a, b) => Number(b.expectancy || 0) - Number(a.expectancy || 0)).slice(0, 4)
    : [];

  if (els.topHoursList) {
    els.topHoursList.innerHTML = topHours.length
      ? topHours.map((item) => `
          <div class="watch-item">
            <div class="watch-item-header">
              <div>
                <strong>${item.key}h</strong>
                <div class="muted small">WR ${Number(item.winRate || 0).toFixed(2)}%</div>
              </div>
              <span class="signal-badge">${Number(item.expectancy || 0).toFixed(4)}</span>
            </div>
          </div>
        `).join("")
      : `<div class="muted">Pas assez de données.</div>`;
  }

  if (els.topSessionsList) {
    els.topSessionsList.innerHTML = topSessions.length
      ? topSessions.map((item) => `
          <div class="watch-item">
            <div class="watch-item-header">
              <div>
                <strong>${item.key}</strong>
                <div class="muted small">WR ${Number(item.winRate || 0).toFixed(2)}%</div>
              </div>
              <span class="signal-badge">${Number(item.expectancy || 0).toFixed(4)}</span>
            </div>
          </div>
        `).join("")
      : `<div class="muted">Pas assez de données.</div>`;
  }
}

function buildPremiumCombo() {
  const journal = appState.journal;
  if (!journal) return null;

  const bestPair = journal.bestPair || null;
  const bestHour = journal.bestHour || null;
  const bestSession = journal.bestSession || null;
  if (!bestPair && !bestHour && !bestSession) return null;

  const pairExp = Number(bestPair?.expectancy || 0);
  const hourExp = Number(bestHour?.expectancy || 0);
  const sessionExp = Number(bestSession?.expectancy || 0);
  const pairWR = Number(bestPair?.winRate || 0);
  const hourWR = Number(bestHour?.winRate || 0);
  const sessionWR = Number(bestSession?.winRate || 0);

  const comboScoreRaw =
    pairExp * 40 +
    hourExp * 25 +
    sessionExp * 25 +
    (pairWR / 100) * 5 +
    (hourWR / 100) * 2.5 +
    (sessionWR / 100) * 2.5;

  const comboScore = Math.max(0, Math.min(100, Math.round(comboScoreRaw * 10)));

  const insights = [];
  if (bestPair) insights.push(`${bestPair.key} est actuellement la meilleure paire historique avec expectancy ${Number(bestPair.expectancy || 0).toFixed(4)}.`);
  if (bestHour) insights.push(`${bestHour.key}h est actuellement la meilleure heure avec win rate ${Number(bestHour.winRate || 0).toFixed(2)}%.`);
  if (bestSession) insights.push(`${bestSession.key} est actuellement la meilleure session avec expectancy ${Number(bestSession.expectancy || 0).toFixed(4)}.`);

  if (comboScore >= 75) insights.push("Le combo historique est très fort. Priorité haute si le setup technique est propre.");
  else if (comboScore >= 55) insights.push("Le combo historique est bon, mais doit rester validé par macro et risk engine.");
  else insights.push("Le combo historique est moyen. Reste très sélectif.");

  return { bestPair, bestHour, bestSession, comboScore, insights };
}

function renderPremiumCombo() {
  const combo = buildPremiumCombo();

  if (!combo) {
    if (els.comboBestPair) els.comboBestPair.textContent = "--";
    if (els.comboBestPairHint) els.comboBestPairHint.textContent = "--";
    if (els.comboBestHour) els.comboBestHour.textContent = "--";
    if (els.comboBestHourHint) els.comboBestHourHint.textContent = "--";
    if (els.comboBestSession) els.comboBestSession.textContent = "--";
    if (els.comboBestSessionHint) els.comboBestSessionHint.textContent = "--";
    if (els.comboScore) els.comboScore.textContent = "--";
    if (els.comboScoreHint) els.comboScoreHint.textContent = "--";
    if (els.comboInsights) els.comboInsights.innerHTML = `<li>Pas assez de données pour construire un combo premium.</li>`;
    return;
  }

  if (els.comboBestPair) els.comboBestPair.textContent = combo.bestPair?.key || "--";
  if (els.comboBestPairHint) {
    els.comboBestPairHint.textContent = combo.bestPair
      ? `WR ${Number(combo.bestPair.winRate || 0).toFixed(2)}% · Exp ${Number(combo.bestPair.expectancy || 0).toFixed(4)}`
      : "--";
  }

  if (els.comboBestHour) els.comboBestHour.textContent = combo.bestHour ? `${combo.bestHour.key}h` : "--";
  if (els.comboBestHourHint) {
    els.comboBestHourHint.textContent = combo.bestHour
      ? `WR ${Number(combo.bestHour.winRate || 0).toFixed(2)}% · Exp ${Number(combo.bestHour.expectancy || 0).toFixed(4)}`
      : "--";
  }

  if (els.comboBestSession) els.comboBestSession.textContent = combo.bestSession?.key || "--";
  if (els.comboBestSessionHint) {
    els.comboBestSessionHint.textContent = combo.bestSession
      ? `WR ${Number(combo.bestSession.winRate || 0).toFixed(2)}% · Exp ${Number(combo.bestSession.expectancy || 0).toFixed(4)}`
      : "--";
  }

  if (els.comboScore) els.comboScore.textContent = `${combo.comboScore}/100`;
  if (els.comboScoreHint) {
    els.comboScoreHint.textContent =
      combo.comboScore >= 75 ? "combo premium fort"
        : combo.comboScore >= 55 ? "combo premium correct"
          : "combo premium faible";
  }

  if (els.comboInsights) els.comboInsights.innerHTML = combo.insights.map((x) => `<li>${x}</li>`).join("");
}

function renderProfessionalStatus(scan, ai) {
  const priority = getDecisionPriority(scan);
  const priorityLabel = priority === 3 ? "P1" : priority === 2 ? "P2" : "P3";

  const entryQuality =
    scan.timingScore >= 75 ? "A" :
    scan.timingScore >= 60 ? "B" :
    scan.timingScore >= 45 ? "C" :
    "D";

  const exitQuality =
    Number(scan.exitSniper?.score || 0) >= 80 ? "A" :
    Number(scan.exitSniper?.score || 0) >= 65 ? "B" :
    Number(scan.exitSniper?.score || 0) >= 50 ? "C" :
    "D";

  const contextAvg = Math.round((scan.contextScore + scan.riskScore) / 2);
  const contextQuality =
    contextAvg >= 75 ? "Strong" :
    contextAvg >= 60 ? "Good" :
    contextAvg >= 45 ? "Average" :
    "Weak";

  if (els.activePriorityLabel) els.activePriorityLabel.textContent = priorityLabel;
  if (els.activePriorityHint) els.activePriorityHint.textContent = ai?.decision || scan.gatekeeper.decision;
  if (els.entryQualityLabel) els.entryQualityLabel.textContent = entryQuality;
  if (els.entryQualityHint) els.entryQualityHint.textContent = `Timing ${scan.timingScore}`;
  if (els.exitQualityLabel) els.exitQualityLabel.textContent = exitQuality;
  if (els.exitQualityHint) els.exitQualityHint.textContent = `${scan.exitSniper?.action || "HOLD"} · RR ${scan.rr}`;
  if (els.contextQualityLabel) els.contextQualityLabel.textContent = contextQuality;
  if (els.contextQualityHint) els.contextQualityHint.textContent = `Risk ${scan.riskScore} · Ctx ${scan.contextScore} · ML ${scan.mlScore ?? "--"}`;
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

async function onAddTrade(event) {
  event.preventDefault();

  const scan = appState.scans.find((s) => s.pair === els.tradePair?.value);
  if (!scan) return;

  const hardBlockCombined = computeCombinedRiskBlock(scan.pair);
  if (hardBlockCombined.blocked) {
    if (els.tradeSuggestionBox) {
      els.tradeSuggestionBox.innerHTML = `
        <strong>TRADE BLOQUÉ</strong><br/>
        ${hardBlockCombined.reason}
      `;
    }
    return;
  }

  const ftmoRisk = await fetchFtmoRisk();
  if (!ftmoRisk.allowed) {
    if (els.tradeSuggestionBox) {
      els.tradeSuggestionBox.innerHTML = `
        <strong>TRADE BLOQUÉ</strong><br/>
        ${ftmoRisk.reason || "Le risque demandé dépasse les limites autorisées."}
      `;
    }
    return;
  }

  const ai = appState.aiDecisionCache[scan.pair] || localDecisionEngine(scan);
  const capital = Number(els.tradeCapital?.value || 0);
  const entry = Number(els.tradeEntry?.value || scan.current);
  const riskPercent = Number(els.riskPercent?.value || 1);

  const riskAmount = capital * (riskPercent / 100);
  const stopDistance = Math.abs(entry - scan.stopLoss) || 0.0001;
  const quantity = riskAmount / stopDistance;
  const leverageExposure = capital * 10;

  const trade = {
    id: crypto.randomUUID(),
    pair: scan.pair,
    direction: els.tradeDirection?.value || scan.direction,
    capital: capital.toFixed(2),
    entry: entry.toFixed(5),
    riskPercent: riskPercent.toFixed(2),
    stopLoss: formatPrice(scan.stopLoss),
    takeProfit: formatPrice(scan.takeProfit),
    quantity: Number.isFinite(quantity) ? quantity.toFixed(2) : "0.00",
    leverageExposure: leverageExposure.toFixed(2),
    aiDecision: ai.decision,
    notes: els.tradeNotes?.value?.trim() || "",
    status: "actif",
    createdAt: new Date().toLocaleString("fr-FR")
  };

  appState.trades.unshift(trade);
  persistState();
  renderTrades();
  renderOverview();
  fetchFtmoRisk();
  fetchJournalInsights();

  els.tradeForm?.reset();
  if (els.tradePair) els.tradePair.value = scan.pair;
  if (els.tradeDirection) els.tradeDirection.value = scan.direction;
  if (els.riskPercent) els.riskPercent.value = "1";
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
  fetchFtmoRisk();
  fetchJournalInsights();
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

function buildJournalContextForPair(scan) {
  const journal = appState.journal;
  if (!journal) return null;

  const now = new Date();
  const hour = Number(now.toLocaleString("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Europe/Paris"
  }));

  const rawSession = getMarketSession(now).label;
  const session = rawSession.includes("London + New York") ? "London+NewYork" : rawSession;

  const pairStat = Array.isArray(journal.pairStats)
    ? journal.pairStats.find((x) => x.key === scan.pair)
    : null;

  const hourStat = Array.isArray(journal.hourStats)
    ? journal.hourStats.find((x) => Number(x.key) === hour)
    : null;

  const sessionStat = Array.isArray(journal.sessionStats)
    ? journal.sessionStats.find((x) => x.key === session)
    : null;

  return {
    pairExpectancy: pairStat?.expectancy ?? 0,
    hourExpectancy: hourStat?.expectancy ?? 0,
    sessionExpectancy: sessionStat?.expectancy ?? 0,
    pairWinRate: pairStat?.winRate ?? 0,
    hourWinRate: hourStat?.winRate ?? 0,
    sessionWinRate: sessionStat?.winRate ?? 0
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
  if (pair.includes("JPY") && session.includes("Tokyo")) return 3;
  return 2;
}

function getCorrelationPenalty(pair) {
  const activePairs = appState.trades
    .filter((trade) => trade.status === "actif")
    .map((trade) => trade.pair);

  const usdCount = activePairs.filter((p) => p.includes("USD")).length;
  if (pair.includes("USD") && usdCount >= 2) return 12;
  if (pair.includes("JPY") && activePairs.some((p) => p.includes("JPY"))) return 8;
  if (pair.includes("GBP") && activePairs.some((p) => p.includes("GBP"))) return 6;
  return 0;
}

function getSpreadPenalty(pair, atrValue) {
  const baseSpread =
    pair === "XAUUSD" ? 0.18 :
    pair === "NAS100" ? 0.28 :
    pair === "GER40" ? 0.22 :
    pair.includes("JPY") ? 0.06 :
    pair.includes("NZD") || pair.includes("CHF") ? 0.055 :
    0.04;

  const normalized = atrValue <= 0 ? 0 : (baseSpread / atrValue) * 100;
  if (normalized > 18) return 12;
  if (normalized > 12) return 8;
  return 3;
}

function getOffSessionPenalty(pair) {
  const session = getMarketSession(new Date()).label;
  if (session === "Off-session") return pair === "XAUUSD" || pair === "NAS100" ? 9 : 7;
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
  reasons.push(
    ctx.tier === 1
      ? "Actif de tier 1 : liquidité élevée, conditions généralement plus propres."
      : ctx.tier === 2
        ? "Actif de tier 2 : bon compromis entre opportunité et sérieux."
        : "Actif de tier 3 : plus opportuniste, à garder très sélectif."
  );

  if (typeof ctx.journalBonus === "number") {
    reasons.push(
      ctx.journalBonus > 0
        ? "Le journal historique favorise ce contexte."
        : ctx.journalBonus < 0
          ? "Le journal historique pénalise ce contexte."
          : "Le journal historique reste neutre ici."
    );
  }

  if (typeof ctx.hourExpectancy === "number") {
    reasons.push(
      ctx.hourExpectancy > 0
        ? "Cette heure est historiquement favorable."
        : ctx.hourExpectancy < 0
          ? "Cette heure est historiquement défavorable."
          : "Cette heure reste neutre historiquement."
    );
  }

  if (typeof ctx.sessionExpectancy === "number") {
    reasons.push(
      ctx.sessionExpectancy > 0
        ? "Cette session est historiquement favorable."
        : ctx.sessionExpectancy < 0
          ? "Cette session est historiquement défavorable."
          : "Cette session reste neutre historiquement."
    );
  }

  if (typeof ctx.premiumComboBonus === "number") {
    reasons.push(
      ctx.premiumComboBonus > 0
        ? "Le combo premium historique renforce ce setup."
        : "Le combo premium n’apporte pas d’avantage particulier ici."
    );
  }

  if (ctx.hardBlockReason) reasons.push(ctx.hardBlockReason);
  if (ctx.combinedRiskReason) reasons.push(ctx.combinedRiskReason);

  if (
    typeof ctx.rawFinalScore === "number" &&
    typeof ctx.finalScore === "number" &&
    ctx.finalScore < ctx.rawFinalScore
  ) {
    reasons.push(`Le score a été plafonné de ${ctx.rawFinalScore} à ${ctx.finalScore} à cause des filtres de sécurité.`);
  }

  if (ctx.priorityLabel) reasons.push(`Priorité scanner : ${ctx.priorityLabel}.`);
  if (ctx.entrySniperReason) reasons.push(`Sniper ${ctx.entrySniperScore ?? "--"} : ${ctx.entrySniperReason}`);
  if (ctx.exitSniperReason) reasons.push(`Exit sniper ${ctx.exitSniperScore ?? "--"} : ${ctx.exitSniperAction || "--"} · ${ctx.exitSniperReason}`);
  if (typeof ctx.mlScore === "number" && ctx.mlScore > 0) reasons.push(`ML ${ctx.mlScore} : ${ctx.mlExplanation || "lecture modèle disponible."}`);

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
    USDCHF: 0.903,
    USDCAD: 1.352,
    AUDUSD: 0.661,
    NZDUSD: 0.607,
    EURGBP: 0.851,
    EURJPY: 163.4,
    GBPJPY: 192.3,
    AUDJPY: 99.1,
    CADJPY: 111.4,
    CHFJPY: 167.3,
    EURAUD: 1.639,
    EURNZD: 1.775,
    EURCAD: 1.465,
    EURCHF: 0.978,
    GBPAUD: 1.924,
    GBPNZD: 2.083,
    GBPCAD: 1.719,
    GBPCHF: 1.149,
    AUDNZD: 1.082,
    AUDCAD: 0.894,
    AUDCHF: 0.597,
    NZDCAD: 0.822,
    NZDCHF: 0.552,
    NZDJPY: 91.7,
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

function computeEntryTriggerScore(scan) {
  let score = 50;

  if (scan.timingScore >= 70) score += 15;
  if (scan.trendScore >= 70) score += 10;
  if (scan.riskScore >= 65) score += 10;
  if (scan.contextScore >= 65) score += 10;
  if (Number(scan.rr) >= 1.8) score += 8;
  if (scan.rsi14 >= 48 && scan.rsi14 <= 62) score += 6;
  if (scan.macdLine > 0) score += 6;

  if (scan.macroPenalty >= 4) score -= 10;
  if (scan.spreadPenalty >= 8) score -= 8;
  if (scan.offSessionPenalty >= 7) score -= 8;
  if (scan.rsi14 > 74 || scan.rsi14 < 26) score -= 6;

  return clamp(score, 1, 99);
}

function computeEntrySniper(scan) {
  const checks = [];
  let score = 50;

  const breakoutReady =
    scan.current >= scan.resistance * 0.998 ||
    scan.current <= scan.support * 1.002;

  const momentumReady = Math.abs(Number(scan.momentum || 0)) >= 0.08;
  const trendReady = Number(scan.trendScore || 0) >= 68;
  const timingReady = Number(scan.timingScore || 0) >= 68;
  const riskReady = Number(scan.riskScore || 0) >= 62;
  const rrReady = Number(scan.rr || 0) >= 1.6;
  const entryReady = Number(scan.entryTriggerScore || 0) >= 70;
  const rsiReady = Number(scan.rsi14 || 0) >= 45 && Number(scan.rsi14 || 0) <= 65;
  const macdReady = Number(scan.macdLine || 0) > 0;

  checks.push({ label: "Breakout/Pullback", ok: breakoutReady });
  checks.push({ label: "Momentum", ok: momentumReady });
  checks.push({ label: "Trend", ok: trendReady });
  checks.push({ label: "Timing", ok: timingReady });
  checks.push({ label: "Risk", ok: riskReady });
  checks.push({ label: "RR", ok: rrReady });
  checks.push({ label: "Entry trigger", ok: entryReady });
  checks.push({ label: "RSI zone", ok: rsiReady });
  checks.push({ label: "MACD", ok: macdReady });

  score += breakoutReady ? 14 : 0;
  score += momentumReady ? 12 : 0;
  score += trendReady ? 12 : 0;
  score += timingReady ? 14 : 0;
  score += riskReady ? 10 : 0;
  score += rrReady ? 8 : 0;
  score += entryReady ? 12 : 0;
  score += rsiReady ? 8 : 0;
  score += macdReady ? 10 : 0;

  const passed = checks.filter((c) => c.ok).length;
  const blocked = passed < 6 || !timingReady || !riskReady || !rsiReady;

  let quality = "weak";
  if (score >= 85) quality = "elite";
  else if (score >= 72) quality = "strong";
  else if (score >= 58) quality = "usable";

  return {
    score: clamp(score, 1, 99),
    passed,
    blocked,
    quality,
    checks,
    reason: blocked
      ? "Le mode sniper refuse l’entrée : alignement insuffisant."
      : "Le mode sniper valide l’entrée : alignement propre."
  };
}

function computeExitSniper(scan, aiDecision) {
  const rr = Number(scan.rr || 0);
  const momentum = Math.abs(Number(scan.momentum || 0));
  const macroDanger = aiDecision?.decision === "NO TRADE";
  const trendScore = Number(scan.trendScore || 0);
  const timingScore = Number(scan.timingScore || 0);
  const riskScore = Number(scan.riskScore || 0);

  const checks = [];
  let score = 50;

  const breakEvenReady = rr >= 1.0;
  const partialReady = rr >= 1.5;
  const trailReady = rr >= 1.8 && trendScore >= 68;
  const momentumWeak = momentum < 0.08;
  const dangerMacro = macroDanger;
  const riskWeak = riskScore < 55 || timingScore < 55;

  checks.push({ label: "Break-even", ok: breakEvenReady });
  checks.push({ label: "Partial", ok: partialReady });
  checks.push({ label: "Trail", ok: trailReady });
  checks.push({ label: "Momentum", ok: !momentumWeak });
  checks.push({ label: "Macro", ok: !dangerMacro });
  checks.push({ label: "Risk", ok: !riskWeak });

  if (breakEvenReady) score += 8;
  if (partialReady) score += 12;
  if (trailReady) score += 14;
  if (momentumWeak) score -= 14;
  if (dangerMacro) score -= 20;
  if (riskWeak) score -= 10;

  let action = "HOLD";
  let quality = "normal";
  let reason = "La sortie peut rester passive pour le moment.";

  if (dangerMacro) {
    action = "EXIT_NOW";
    quality = "urgent";
    reason = "Le contexte macro devient dangereux. Sortie immédiate recommandée.";
  } else if (partialReady && momentumWeak) {
    action = "PARTIAL_EXIT";
    quality = "strong";
    reason = "Le trade a avancé mais le momentum s’essouffle. Sortie partielle recommandée.";
  } else if (trailReady) {
    action = "TRAIL_STOP";
    quality = "strong";
    reason = "Le trade est assez mature pour un trailing stop agressif.";
  } else if (breakEvenReady) {
    action = "MOVE_TO_BREAKEVEN";
    quality = "good";
    reason = "Le trade a assez progressé pour passer au break-even.";
  } else if (riskWeak) {
    action = "LIGHTEN";
    quality = "weak";
    reason = "Le contexte de maintien du trade devient plus fragile.";
  }

  return {
    score: clamp(score, 1, 99),
    quality,
    action,
    reason,
    checks
  };
}

function applyFinalScoreCap({ rawFinalScore, gatekeeperDecision, hardBlockLocal, macroPenalty, aiDecision }) {
  let cappedScore = rawFinalScore;

  if (gatekeeperDecision === "WAIT") cappedScore = Math.min(cappedScore, 69);
  if (gatekeeperDecision === "NO TRADE") cappedScore = Math.min(cappedScore, 49);
  if (hardBlockLocal?.blocked) cappedScore = Math.min(cappedScore, 44);
  if (hardBlockLocal?.blocked && macroPenalty >= 4) cappedScore = Math.min(cappedScore, 28);
  if (aiDecision?.decision === "NO TRADE") cappedScore = Math.min(cappedScore, 24);

  return Math.max(1, Math.round(cappedScore));
}

function computeJournalLocalBonus(pair) {
  const journal = appState.journal;
  if (!journal || !Array.isArray(journal.pairStats)) return 0;

  const stat = journal.pairStats.find((x) => x.key === pair);
  if (!stat) return 0;

  const expectancy = Number(stat.expectancy || 0);
  if (expectancy > 0.5) return 6;
  if (expectancy > 0.15) return 3;
  if (expectancy < -0.5) return -8;
  if (expectancy < -0.15) return -4;
  return 0;
}

function computeTimeSessionLocalBonus() {
  const journal = appState.journal;
  if (!journal) return { bonus: 0, hourExpectancy: 0, sessionExpectancy: 0 };

  const now = new Date();
  const hour = Number(now.toLocaleString("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Europe/Paris"
  }));

  const rawSession = getMarketSession(now).label;
  const session = rawSession.includes("London + New York") ? "London+NewYork" : rawSession;

  const hourStat = Array.isArray(journal.hourStats)
    ? journal.hourStats.find((x) => Number(x.key) === hour)
    : null;

  const sessionStat = Array.isArray(journal.sessionStats)
    ? journal.sessionStats.find((x) => x.key === session)
    : null;

  const hourExpectancy = Number(hourStat?.expectancy ?? 0);
  const sessionExpectancy = Number(sessionStat?.expectancy ?? 0);

  let bonus = 0;

  if (hourExpectancy > 0.5) bonus += 5;
  else if (hourExpectancy > 0.15) bonus += 2;
  else if (hourExpectancy < -0.5) bonus -= 6;
  else if (hourExpectancy < -0.15) bonus -= 3;

  if (sessionExpectancy > 0.5) bonus += 5;
  else if (sessionExpectancy > 0.15) bonus += 2;
  else if (sessionExpectancy < -0.5) bonus -= 6;
  else if (sessionExpectancy < -0.15) bonus -= 3;

  return { bonus, hourExpectancy, sessionExpectancy };
}

function buildPremiumCombo() {
  const journal = appState.journal;
  if (!journal) return null;

  const bestPair = journal.bestPair || null;
  const bestHour = journal.bestHour || null;
  const bestSession = journal.bestSession || null;
  if (!bestPair && !bestHour && !bestSession) return null;

  const pairExp = Number(bestPair?.expectancy || 0);
  const hourExp = Number(bestHour?.expectancy || 0);
  const sessionExp = Number(bestSession?.expectancy || 0);
  const pairWR = Number(bestPair?.winRate || 0);
  const hourWR = Number(bestHour?.winRate || 0);
  const sessionWR = Number(bestSession?.winRate || 0);

  const comboScoreRaw =
    pairExp * 40 +
    hourExp * 25 +
    sessionExp * 25 +
    (pairWR / 100) * 5 +
    (hourWR / 100) * 2.5 +
    (sessionWR / 100) * 2.5;

  const comboScore = Math.max(0, Math.min(100, Math.round(comboScoreRaw * 10)));

  return { bestPair, bestHour, bestSession, comboScore };
}

function computePremiumComboBonus(pair) {
  const combo = buildPremiumCombo();
  if (!combo) return 0;

  const now = new Date();
  const hour = Number(now.toLocaleString("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Europe/Paris"
  }));

  const rawSession = getMarketSession(now).label;
  const session = rawSession.includes("London + New York") ? "London+NewYork" : rawSession;

  let bonus = 0;
  if (combo.bestPair?.key === pair) bonus += 4;
  if (Number(combo.bestHour?.key) === hour) bonus += 3;
  if (combo.bestSession?.key === session) bonus += 3;
  return bonus;
}

function computeHardBlockLocalPenalty(pair) {
  const journal = appState.journal;
  if (!journal) return { penalty: 0, blocked: false, reason: "" };

  const pairBonus = computeJournalLocalBonus(pair);
  const timeSession = computeTimeSessionLocalBonus();
  const combo = buildPremiumCombo();

  let penalty = 0;
  let blocked = false;
  let reason = "";

  if (pairBonus <= -4) penalty += 8;
  if (timeSession.bonus <= -6) penalty += 10;
  if (combo && combo.comboScore < 40) penalty += 6;

  if (pairBonus <= -4 && timeSession.bonus <= -6) {
    blocked = true;
    reason = "Le contexte historique local est trop faible : paire + heure/session défavorables.";
  }

  return { penalty, blocked, reason };
}

function computeCombinedRiskBlock(pair) {
  const hardBlockLocal = computeHardBlockLocalPenalty(pair);
  const selectedScan = appState.scans.find((s) => s.pair === pair);
  const aiDecision = appState.aiDecisionCache[pair];

  const macroLooksBad =
    aiDecision?.decision === "NO TRADE" ||
    selectedScan?.macroPenalty >= 4;

  if (hardBlockLocal.blocked && macroLooksBad) {
    return {
      blocked: true,
      reason: "Contexte local historique faible + risque macro non propre."
    };
  }

  if (hardBlockLocal.penalty >= 10 && macroLooksBad) {
    return {
      blocked: true,
      reason: "Accumulation de signaux faibles : journal local mauvais et risque macro présent."
    };
  }

  return { blocked: false, reason: "" };
}

function autoSelectBestP1() {
  if (!appState.autoFocusBestP1) return;

  const bestP1 = [...appState.scans]
    .filter((scan) => getDecisionPriority(scan) === 3)
    .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))[0];

  if (bestP1) appState.selectedPair = bestP1.pair;
}

function updateOnlyP1Button() {
  if (!els.onlyP1Btn) return;
  els.onlyP1Btn.textContent = `Only P1: ${appState.onlyP1Mode ? "ON" : "OFF"}`;
  els.onlyP1Btn.classList.toggle("active-chip", appState.onlyP1Mode);
}

function updateAutoFocusButton() {
  if (!els.autoFocusBtn) return;
  els.autoFocusBtn.textContent = `Auto Focus: ${appState.autoFocusBestP1 ? "ON" : "OFF"}`;
  els.autoFocusBtn.classList.toggle("active-chip", appState.autoFocusBestP1);
}

function updateEntrySniperButton() {
  if (!els.entrySniperBtn) return;
  els.entrySniperBtn.textContent = `Entry Sniper: ${appState.entrySniperMode ? "ON" : "OFF"}`;
  els.entrySniperBtn.classList.toggle("active-chip", appState.entrySniperMode);
}

function updateExitSniperButton() {
  if (!els.exitSniperBtn) return;
  els.exitSniperBtn.textContent = `Exit Sniper: ${appState.exitSniperMode ? "ON" : "OFF"}`;
  els.exitSniperBtn.classList.toggle("active-chip", appState.exitSniperMode);
}

function renderTimeframeButtons() {
  if (!els.timeframeRow) return;
  els.timeframeRow.innerHTML = "";

  TIMEFRAMES.forEach((tf) => {
    const btn = document.createElement("button");
    btn.className = "ghost-btn";
    btn.textContent = tf;

    if (appState.timeframe === tf) btn.classList.add("active-chip");

    btn.addEventListener("click", () => {
      appState.timeframe = tf;
      persistState();
      renderTimeframeButtons();
      refreshAll(true);
    });

    els.timeframeRow.appendChild(btn);
  });
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
