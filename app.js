const PAIRS = [
  { symbol: 'EURUSD', group: 'forex', quote: 'USD' },
  { symbol: 'GBPUSD', group: 'forex', quote: 'USD' },
  { symbol: 'USDJPY', group: 'yen', quote: 'JPY' },
  { symbol: 'EURJPY', group: 'yen', quote: 'JPY' },
  { symbol: 'AUDUSD', group: 'forex', quote: 'USD' },
  { symbol: 'NZDUSD', group: 'forex', quote: 'USD' },
  { symbol: 'USDCAD', group: 'forex', quote: 'CAD' },
  { symbol: 'USDCHF', group: 'forex', quote: 'CHF' },
  { symbol: 'XAUUSD', group: 'metals', quote: 'USD' },
  { symbol: 'GER40', group: 'indices', quote: 'EUR' },
  { symbol: 'NAS100', group: 'indices', quote: 'USD' },
];
const TIMEFRAMES = ['M5', 'M15', 'H1', 'H4'];
const STORAGE_KEY = 'ftmo-edge-state-v2';

const defaultState = {
  timeframe: 'H1',
  strategy: 'balanced',
  marketFilter: 'all',
  selectedPair: 'EURUSD',
  search: '',
  trades: [],
  watchlist: [],
  scans: [],
  macroEvents: [],
};

const appState = {
  ...structuredClone(defaultState),
  chart: null,
  candleSeries: null,
  priceSeries: new Map(),
};

const els = {};

document.addEventListener('DOMContentLoaded', init);

function init() {
  hydrateState();
  cacheEls();
  buildTimeframes();
  seedMacroCalendar();
  bindEvents();
  initChart();
  refreshAll();
}

function cacheEls() {
  [
    'timeframeRow','strategyMode','marketFilter','pairSearch','pairList','pairCount','bestScore','selectedPairName','selectedSignalBadge',
    'summaryMetrics','reasonList','historicalComparison','chart','tradePair','tradeDirection','tradeCapital','tradeEntry','riskPercent',
    'tradeNotes','tradeForm','tradeSuggestionBox','tradeList','macroEvents','localClock','activeSessionPill','riskPill','marketBiasPill',
    'sessionHeadline','sessionSubline','refreshBtn','settingsBtn','settingsModal','closeSettingsBtn','clearTradesBtn','watchlist','watchlistBtn',
    'watchlistCount','topPairLabel','topPairReason','buyCount','sellCount','globalRisk','trendMini','confidenceMini','rrMini','bridgeBtn',
    'tradeStats','exportBtn'
  ].forEach(id => els[id] = document.getElementById(id));
}

function hydrateState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    Object.assign(appState, defaultState, JSON.parse(raw));
  } catch {
    Object.assign(appState, structuredClone(defaultState));
  }
}

function persistState() {
  const copy = {
    timeframe: appState.timeframe,
    strategy: appState.strategy,
    marketFilter: appState.marketFilter,
    selectedPair: appState.selectedPair,
    search: appState.search,
    trades: appState.trades,
    watchlist: appState.watchlist,
    scans: appState.scans,
    macroEvents: appState.macroEvents,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(copy));
}

function buildTimeframes() {
  els.timeframeRow.innerHTML = '';
  TIMEFRAMES.forEach(tf => {
    const btn = document.createElement('button');
    btn.className = `chip ${appState.timeframe === tf ? 'active' : ''}`;
    btn.textContent = tf;
    btn.addEventListener('click', () => {
      appState.timeframe = tf;
      buildTimeframes();
      refreshAll();
    });
    els.timeframeRow.appendChild(btn);
  });
  els.strategyMode.value = appState.strategy;
  els.marketFilter.value = appState.marketFilter;
}

function bindEvents() {
  els.refreshBtn.addEventListener('click', refreshAll);
  els.strategyMode.addEventListener('change', e => { appState.strategy = e.target.value; persistState(); refreshAll(); });
  els.marketFilter.addEventListener('change', e => { appState.marketFilter = e.target.value; persistState(); renderPairList(); });
  els.pairSearch.addEventListener('input', e => { appState.search = e.target.value.trim().toUpperCase(); renderPairList(); });
  els.tradeForm.addEventListener('submit', handleTradeSubmit);
  els.clearTradesBtn.addEventListener('click', () => { appState.trades = []; persistState(); renderTrades(); });
  els.settingsBtn.addEventListener('click', () => els.settingsModal.classList.remove('hidden'));
  els.bridgeBtn.addEventListener('click', () => els.settingsModal.classList.remove('hidden'));
  els.closeSettingsBtn.addEventListener('click', () => els.settingsModal.classList.add('hidden'));
  els.settingsModal.addEventListener('click', e => { if (e.target === els.settingsModal) els.settingsModal.classList.add('hidden'); });
  els.watchlistBtn.addEventListener('click', toggleCurrentWatchlist);
  els.exportBtn.addEventListener('click', exportTradesJson);
}

function refreshAll() {
  updateClockAndSession();
  appState.scans = PAIRS.map(item => scanPair(item, appState.timeframe, appState.strategy)).sort((a, b) => b.score - a.score);
  if (!appState.scans.find(s => s.pair === appState.selectedPair)) appState.selectedPair = appState.scans[0]?.pair || 'EURUSD';
  persistState();
  renderOverview();
  renderPairList();
  renderSelectedPair();
  renderMacroEvents();
  renderTrades();
  renderWatchlist();
}

function updateClockAndSession() {
  const now = new Date();
  els.localClock.textContent = now.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
  const session = getMarketSession(now);
  const risk = getMacroRiskLevel(now, appState.selectedPair || 'EURUSD');
  els.activeSessionPill.textContent = session.label;
  els.riskPill.textContent = risk.text;
  els.marketBiasPill.textContent = session.biasLabel;
  els.sessionHeadline.textContent = session.headline;
  els.sessionSubline.textContent = risk.description;
}

function getMarketSession(date) {
  const hourParis = Number(date.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Paris' }));
  const tokyo = hourParis >= 1 && hourParis < 10;
  const london = hourParis >= 9 && hourParis < 18;
  const newYork = hourParis >= 14 && hourParis < 23;
  const overlap = london && newYork;

  if (overlap) return { label: 'London + New York', headline: 'Liquidité élevée : idéal pour cassures, momentum et continuation.', biasLabel: 'Volatilité forte' };
  if (london) return { label: 'London', headline: 'Session Londres : très utile pour EUR, GBP, indices européens.', biasLabel: 'Bias Europe' };
  if (newYork) return { label: 'New York', headline: 'Session US : surveille USD, or, NAS100 et news américaines.', biasLabel: 'Bias US' };
  if (tokyo) return { label: 'Tokyo', headline: 'Session Asie : JPY, AUD et NZD deviennent plus intéressants.', biasLabel: 'Bias Asie' };
  return { label: 'Off-session', headline: 'Liquidité plus faible : filtrer davantage et réduire le risque.', biasLabel: 'Liquidité faible' };
}

function seedMacroCalendar() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  appState.macroEvents = [
    makeEvent('US CPI', new Date(y, m, d, 14, 30), 'USD', 'high', 'Inflation US : mouvement brutal possible sur USD, XAUUSD, NAS100.'),
    makeEvent('FOMC Member Speech', new Date(y, m, d, 18, 45), 'USD', 'medium', 'Communication Fed : risque d’accélération ou de rejet sur les actifs USD.'),
    makeEvent('UK CPI', new Date(y, m, d + 1, 8, 0), 'GBP', 'high', 'Volatilité forte possible sur GBP pairs.'),
    makeEvent('EZ PMI', new Date(y, m, d + 1, 10, 0), 'EUR', 'medium', 'Impact plutôt direct sur EUR et indices européens.'),
    makeEvent('BoJ Outlook', new Date(y, m, d + 2, 5, 0), 'JPY', 'high', 'Événement critique pour JPY pairs.'),
    makeEvent('CAD Employment', new Date(y, m, d + 2, 14, 30), 'CAD', 'medium', 'Surveiller USDCAD autour de la publication.'),
  ].sort((a, b) => a.date - b.date);
}

function makeEvent(name, date, currency, impact, description) {
  return { name, date, currency, impact, description };
}

function getMacroRiskLevel(now, pair) {
  const relevant = appState.macroEvents.filter(evt => pair.includes(evt.currency));
  const near = relevant.find(evt => Math.abs(evt.date - now) <= 90 * 60 * 1000);
  if (near) {
    return { level: near.impact, text: `Macro ${near.impact.toUpperCase()}`, description: `${near.name} proche (${formatEventTime(near.date)}). Réduis l’exposition ou attends la stabilisation.` };
  }
  const next = relevant[0];
  return { level: 'low', text: next ? `Prochain ${next.currency}` : 'Macro calme', description: next ? `${next.name} à ${formatEventTime(next.date)}. Hors fenêtre critique pour l’instant.` : `Aucun événement critique détecté pour ${pair}.` };
}

function formatEventTime(date) {
  return date.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function scanPair(item, timeframe, strategy) {
  const pair = item.symbol;
  const candles = generateCandles(pair, timeframe);
  appState.priceSeries.set(pair, candles);

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const current = closes.at(-1);
  const previous = closes.at(-2);

  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const latestEma20 = ema20.at(-1);
  const latestEma50 = ema50.at(-1);
  const rsi14 = rsi(closes, 14);
  const macd = ema(closes, 12) - ema(closes, 26);
  const macdSignal = ema(seriesSlice(closes, 18), 9);
  const atr14 = atr(highs, lows, closes, 14);
  const support = Math.min(...lows.slice(-20));
  const resistance = Math.max(...highs.slice(-20));
  const momentum = ((current - closes.at(-12)) / closes.at(-12)) * 100;
  const structure = detectStructure(highs, lows);
  const candleSignal = detectLastCandleSignal(candles);
  const historical = historicalSimilarity(pair, timeframe, rsi14, momentum, atr14);
  const sessionBoost = getSessionBoost(pair);
  const macroPenalty = getPairMacroPenalty(pair);
  const volumeProxy = estimateVolumeProxy(candles);
  const trendStrength = Math.abs(((latestEma20 - latestEma50) / latestEma50) * 100);

  let score = 50;
  score += latestEma20 > latestEma50 ? 10 : -10;
  score += current > latestEma20 ? 7 : -7;
  score += macd > macdSignal ? 7 : -6;
  score += structure.bias;
  score += candleSignal.bias;
  score += historical.edge;
  score += sessionBoost;
  score -= macroPenalty;
  score += volumeProxy.edge;

  if (rsi14 > 52 && rsi14 < 67) score += 8;
  else if (rsi14 < 33) score += strategy === 'reversal' ? 11 : 5;
  else if (rsi14 > 71) score += strategy === 'reversal' ? -3 : -7;

  if (strategy === 'trend') score += latestEma20 > latestEma50 ? 7 : -4;
  if (strategy === 'reversal') score += (rsi14 < 35 || rsi14 > 68) ? 9 : -5;
  if (strategy === 'breakout') score += current > resistance * 0.998 || current < support * 1.002 ? 8 : -2;
  if (strategy === 'scalp') score += sessionBoost > 0 ? 8 : -6;

  score = Math.max(1, Math.min(99, Math.round(score)));

  let signal = 'WAIT';
  if (score >= 82) signal = 'STRONG BUY';
  else if (score >= 68) signal = 'BUY';
  else if (score <= 24) signal = 'STRONG SELL';
  else if (score <= 38) signal = 'SELL';

  const direction = signal.includes('SELL') ? 'sell' : 'buy';
  const stopLoss = direction === 'buy' ? current - atr14 * 1.4 : current + atr14 * 1.4;
  const takeProfit = direction === 'buy' ? current + atr14 * 2.4 : current - atr14 * 2.4;
  const rr = Math.abs((takeProfit - current) / (current - stopLoss || 1)).toFixed(2);
  const confidence = Math.max(1, Math.min(99, Math.round(score * 0.7 + historical.confidence * 0.3)));
  const reasons = buildReasons({ latestEma20, latestEma50, rsi14, macd, macdSignal, momentum, structure, candleSignal, historical, macroPenalty, sessionBoost, support, resistance, volumeProxy, trendStrength });

  return {
    pair, group: item.group, timeframe, candles, current, previous,
    ema20: latestEma20, ema50: latestEma50, rsi14, macd, macdSignal, atr14,
    support, resistance, momentum, structure, candleSignal, historical, volumeProxy,
    score, confidence, signal, risk: Math.max(0.1, (atr14 / current) * 100),
    stopLoss, takeProfit, rr, reasons,
    trend: latestEma20 > latestEma50 ? 'Bullish' : 'Bearish',
    trendStrength,
  };
}

function renderOverview() {
  const best = appState.scans[0];
  const buys = appState.scans.filter(s => s.signal.includes('BUY')).length;
  const sells = appState.scans.filter(s => s.signal.includes('SELL')).length;
  const highRisk = appState.macroEvents.some(evt => Math.abs(evt.date - new Date()) <= 90 * 60 * 1000 && evt.impact === 'high');
  els.topPairLabel.textContent = best ? `${best.pair} · ${best.signal}` : '--';
  els.topPairReason.textContent = best ? `${best.trend} · confidence ${best.confidence}` : '--';
  els.buyCount.textContent = buys;
  els.sellCount.textContent = sells;
  els.globalRisk.textContent = highRisk ? 'Élevé' : 'Modéré';
}

function renderPairList() {
  let list = appState.scans;
  if (appState.marketFilter !== 'all') list = list.filter(scan => scan.group === appState.marketFilter);
  if (appState.search) list = list.filter(scan => scan.pair.includes(appState.search));
  els.pairCount.textContent = `${list.length} paire(s)`;
  els.bestScore.textContent = appState.scans[0]?.score ?? '--';
  els.pairList.innerHTML = '';

  list.forEach(scan => {
    const div = document.createElement('button');
    div.className = 'pair-item';
    div.addEventListener('click', () => {
      appState.selectedPair = scan.pair;
      persistState();
      renderSelectedPair();
      updateClockAndSession();
    });
    const signalClass = scan.signal.includes('BUY') ? 'signal-buy' : scan.signal.includes('SELL') ? 'signal-sell' : '';
    div.innerHTML = `
      <div class="pair-left">
        <div class="pair-title-row">
          <span class="pair-symbol">${scan.pair}</span>
          <span class="signal-badge ${signalClass}">${scan.signal}</span>
        </div>
        <div class="pair-meta">
          <span class="tag">${scan.trend}</span>
          <span class="tag">RSI ${scan.rsi14.toFixed(1)}</span>
          <span class="tag">Conf ${scan.confidence}</span>
          <span class="tag">RR ${scan.rr}</span>
        </div>
      </div>
      <div class="score-badge ${scan.score >= 70 ? 'good' : scan.score <= 35 ? 'bad' : ''}">${scan.score}</div>
    `;
    els.pairList.appendChild(div);
  });
}

function renderSelectedPair() {
  const scan = appState.scans.find(s => s.pair === appState.selectedPair) || appState.scans[0];
  if (!scan) return;

  els.selectedPairName.textContent = scan.pair;
  els.selectedSignalBadge.textContent = scan.signal;
  els.tradePair.value = scan.pair;
  els.trendMini.textContent = scan.trend;
  els.confidenceMini.textContent = scan.confidence;
  els.rrMini.textContent = scan.rr;
  els.watchlistBtn.textContent = appState.watchlist.includes(scan.pair) ? '★ Watchlist' : '☆ Watchlist';

  const metrics = [
    ['Prix', String(scan.current)],
    ['RSI', scan.rsi14.toFixed(1)],
    ['ATR', scan.atr14.toFixed(4)],
    ['Trend', scan.trend],
    ['Score', String(scan.score)],
    ['Confidence', String(scan.confidence)],
    ['Risk %', scan.risk.toFixed(2)],
    ['Structure', scan.structure.label],
  ];
  els.summaryMetrics.innerHTML = metrics.map(([label, value]) => `<div class="metric-card"><span class="muted">${label}</span><strong>${value}</strong></div>`).join('');
  els.reasonList.innerHTML = scan.reasons.map(r => `<li>${r}</li>`).join('');
  els.historicalComparison.innerHTML = `
    <div>Edge historique moyen : <strong class="${scan.historical.avgOutcome > 0 ? 'good' : 'bad'}">${scan.historical.avgOutcome.toFixed(2)}R</strong></div>
    <div style="margin-top:8px">Confiance historique : <strong>${scan.historical.confidence}</strong></div>
    <div style="margin-top:10px">Cas proches : ${scan.historical.top.map(t => `<span class="tag">${t.year} / ${t.outcome.toFixed(1)}R</span>`).join(' ')}</div>
    <div style="margin-top:10px">Plan suggéré : SL <strong>${fmt(scan.pair, scan.stopLoss)}</strong> · TP <strong>${fmt(scan.pair, scan.takeProfit)}</strong> · RR <strong>${scan.rr}</strong></div>
  `;

  updateTradeSuggestion(scan);
  updateChart(scan.candles);
}

function renderMacroEvents() {
  els.macroEvents.innerHTML = '';
  appState.macroEvents.forEach(evt => {
    const div = document.createElement('div');
    div.className = 'macro-item';
    div.innerHTML = `
      <div class="macro-top">
        <strong>${evt.name}</strong>
        <span class="tag ${evt.impact === 'high' ? 'warn' : ''}">${evt.impact.toUpperCase()}</span>
      </div>
      <div class="macro-meta" style="margin-top:8px">
        <span class="tag">${evt.currency}</span>
        <span class="tag">${formatEventTime(evt.date)}</span>
      </div>
      <p class="muted" style="margin-top:8px">${evt.description}</p>
    `;
    els.macroEvents.appendChild(div);
  });
}

function toggleCurrentWatchlist() {
  const pair = appState.selectedPair;
  if (!pair) return;
  if (appState.watchlist.includes(pair)) appState.watchlist = appState.watchlist.filter(p => p !== pair);
  else appState.watchlist.unshift(pair);
  persistState();
  renderWatchlist();
  renderSelectedPair();
}

function renderWatchlist() {
  els.watchlist.innerHTML = '';
  els.watchlistCount.textContent = `${appState.watchlist.length} élément(s)`;
  if (!appState.watchlist.length) {
    els.watchlist.innerHTML = '<div class="watch-item"><span class="muted">Aucune paire ajoutée pour le moment.</span></div>';
    return;
  }
  appState.watchlist.forEach(pair => {
    const scan = appState.scans.find(s => s.pair === pair);
    const div = document.createElement('div');
    div.className = 'watch-item';
    div.innerHTML = `
      <div class="watch-main">
        <strong>${pair}</strong>
        <span class="muted">${scan ? `${scan.signal} · score ${scan.score}` : 'hors scan courant'}</span>
      </div>
      <div class="row-actions">
        <button class="ghost-btn" data-open="${pair}">Ouvrir</button>
        <button class="ghost-btn danger" data-remove="${pair}">Retirer</button>
      </div>
    `;
    els.watchlist.appendChild(div);
  });
  els.watchlist.querySelectorAll('[data-open]').forEach(btn => btn.addEventListener('click', () => {
    appState.selectedPair = btn.dataset.open; persistState(); renderSelectedPair();
  }));
  els.watchlist.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => {
    appState.watchlist = appState.watchlist.filter(p => p !== btn.dataset.remove); persistState(); renderWatchlist(); renderSelectedPair();
  }));
}

function initChart() {
  appState.chart = LightweightCharts.createChart(document.getElementById('chart'), {
    layout: { background: { color: '#08111f' }, textColor: '#c7d6f6' },
    grid: { vertLines: { color: 'rgba(255,255,255,0.06)' }, horzLines: { color: 'rgba(255,255,255,0.06)' } },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
    timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: true },
    crosshair: { mode: 0 },
    autoSize: true,
  });
  appState.candleSeries = appState.chart.addCandlestickSeries({
    upColor: '#22d07d', downColor: '#ff667f', wickUpColor: '#22d07d', wickDownColor: '#ff667f', borderVisible: false,
  });
}

function updateChart(candles) {
  if (!appState.candleSeries) return;
  appState.candleSeries.setData(candles);
  appState.chart.timeScale().fitContent();
}

function updateTradeSuggestion(scan) {
  const riskCash = Number(els.tradeCapital.value || 1000) * (Number(els.riskPercent.value || 1) / 100);
  const stopDistance = Math.abs(scan.current - scan.stopLoss) || 1;
  const sizeApprox = riskCash / stopDistance;
  const exitText = scan.signal.includes('BUY')
    ? 'exit si cassure de structure baissière, RSI sous 48, ou macro high impact imminente'
    : scan.signal.includes('SELL')
      ? 'exit si invalidation haussière, RSI au-dessus de 52, ou macro high impact imminente'
      : 'attendre confirmation ou rejet plus propre avant entrée';

  els.tradeSuggestionBox.innerHTML = `
    <div><strong>${scan.signal}</strong> · score ${scan.score} · confidence ${scan.confidence}</div>
    <div style="margin-top:8px">Entrée de référence proche de <strong>${fmt(scan.pair, scan.current)}</strong></div>
    <div style="margin-top:8px">SL <strong>${fmt(scan.pair, scan.stopLoss)}</strong> · TP <strong>${fmt(scan.pair, scan.takeProfit)}</strong> · RR <strong>${scan.rr}</strong></div>
    <div style="margin-top:8px">Risque théorique cash ≈ <strong>${riskCash.toFixed(2)}</strong> · taille approx ≈ <strong>${sizeApprox.toFixed(2)}</strong></div>
    <div style="margin-top:8px">Exit logique : ${exitText}</div>
  `;
}

function handleTradeSubmit(e) {
  e.preventDefault();
  const pair = els.tradePair.value;
  const direction = els.tradeDirection.value;
  const capital = Number(els.tradeCapital.value);
  const entry = Number(els.tradeEntry.value);
  const riskPercent = Number(els.riskPercent.value);
  const notes = els.tradeNotes.value.trim();
  const scan = appState.scans.find(s => s.pair === pair);
  if (!pair || !capital || !entry || !scan || !riskPercent) return;

  appState.trades.unshift({
    id: crypto.randomUUID(), pair, direction, capital, entry, riskPercent, notes,
    createdAt: new Date().toISOString(), stopLoss: scan.stopLoss, takeProfit: scan.takeProfit, timeframe: scan.timeframe,
  });
  persistState();
  renderTrades();
  els.tradeCapital.value = '';
  els.tradeEntry.value = '';
  els.tradeNotes.value = '';
}

function renderTrades() {
  els.tradeList.innerHTML = '';
  els.tradeStats.textContent = `${appState.trades.length} trade(s)`;
  if (!appState.trades.length) {
    els.tradeList.innerHTML = '<div class="trade-item"><p class="muted">Aucun trade enregistré pour le moment.</p></div>';
    return;
  }
  appState.trades.forEach(trade => {
    const scan = appState.scans.find(s => s.pair === trade.pair);
    const current = scan?.current ?? trade.entry;
    const pnlPct = trade.direction === 'buy' ? ((current - trade.entry) / trade.entry) * 100 : ((trade.entry - current) / trade.entry) * 100;
    const pnlValue = trade.capital * pnlPct / 100;
    const shouldExit = shouldExitTrade(trade, scan);
    const div = document.createElement('div');
    div.className = 'trade-item';
    div.innerHTML = `
      <div class="trade-top">
        <strong>${trade.pair} · ${trade.direction.toUpperCase()} · ${trade.timeframe}</strong>
        <button class="ghost-btn danger" data-delete="${trade.id}">Supprimer</button>
      </div>
      <div class="trade-meta" style="margin-top:8px">
        <span class="tag">Entrée ${fmt(trade.pair, trade.entry)}</span>
        <span class="tag">Actuel ${fmt(trade.pair, current)}</span>
        <span class="tag">Capital ${trade.capital}</span>
        <span class="tag">Risque ${trade.riskPercent}%</span>
      </div>
      <p style="margin-top:10px" class="${pnlPct >= 0 ? 'good' : 'bad'}">PnL estimé : ${pnlPct.toFixed(2)}% (${pnlValue.toFixed(2)})</p>
      <p class="muted" style="margin-top:6px">SL ${fmt(trade.pair, trade.stopLoss)} · TP ${fmt(trade.pair, trade.takeProfit)}</p>
      ${trade.notes ? `<p class="muted" style="margin-top:6px">Notes : ${escapeHtml(trade.notes)}</p>` : ''}
      <p style="margin-top:8px"><strong>${shouldExit ? 'EXIT conseillé' : 'Conserver / surveiller'}</strong> — ${exitReason(trade, scan, shouldExit)}</p>
    `;
    els.tradeList.appendChild(div);
  });
  els.tradeList.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', () => {
    appState.trades = appState.trades.filter(t => t.id !== btn.dataset.delete);
    persistState();
    renderTrades();
  }));
}

function shouldExitTrade(trade, scan) {
  if (!scan) return false;
  const current = scan.current;
  if (trade.direction === 'buy') return current <= trade.stopLoss || current >= trade.takeProfit || scan.signal.includes('SELL') || scan.rsi14 > 74;
  return current >= trade.stopLoss || current <= trade.takeProfit || scan.signal.includes('BUY') || scan.rsi14 < 26;
}

function exitReason(trade, scan, shouldExit) {
  if (!scan) return 'Données non disponibles.';
  if (!shouldExit) return 'Le setup principal n’est pas encore invalidé.';
  const current = scan.current;
  if (trade.direction === 'buy' && current >= trade.takeProfit) return 'objectif atteint';
  if (trade.direction === 'sell' && current <= trade.takeProfit) return 'objectif atteint';
  if (trade.direction === 'buy' && current <= trade.stopLoss) return 'stop ou invalidation touché';
  if (trade.direction === 'sell' && current >= trade.stopLoss) return 'stop ou invalidation touché';
  return 'le moteur détecte une dégradation du contexte ou un retournement probable';
}

function exportTradesJson() {
  const payload = JSON.stringify(appState.trades, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ftmo-edge-trades.json';
  a.click();
  URL.revokeObjectURL(url);
}

function generateCandles(pair, timeframe) {
  const seed = hashCode(pair + timeframe);
  const length = timeframe === 'M5' ? 180 : timeframe === 'M15' ? 190 : timeframe === 'H1' ? 220 : 240;
  const base = pair === 'XAUUSD' ? 2350 : pair === 'GER40' ? 18400 : pair === 'NAS100' ? 18250 : 1 + (Math.abs(seed) % 1000) / 1000;
  const step = timeframe === 'M5' ? 300 : timeframe === 'M15' ? 900 : timeframe === 'H1' ? 3600 : 14400;
  let price = base;
  const out = [];
  for (let i = length; i > 0; i--) {
    const t = Math.floor(Date.now() / 1000) - i * step;
    const drift = Math.sin((i + seed) / 15) * driftScale(pair) + Math.cos((i + seed) / 8) * driftScale(pair) * 0.7;
    const noise = pseudoRand(seed + i) * noiseScale(pair);
    const open = price;
    price = Math.max(0.0001, price + drift + noise * 0.6);
    const close = price;
    const wick = Math.abs(noise) * wickScale(pair);
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    out.push({ time: t, open: roundByPair(pair, open), high: roundByPair(pair, high), low: roundByPair(pair, low), close: roundByPair(pair, close) });
  }
  return out;
}

function driftScale(pair) { return pair === 'XAUUSD' ? 1.7 : pair === 'GER40' ? 13 : pair === 'NAS100' ? 19 : 0.0018; }
function noiseScale(pair) { return pair === 'XAUUSD' ? 5 : pair === 'GER40' ? 32 : pair === 'NAS100' ? 44 : 0.0032; }
function wickScale(pair) { return pair === 'XAUUSD' ? 3 : pair === 'GER40' ? 19 : pair === 'NAS100' ? 24 : 0.0022; }

function roundByPair(pair, n) {
  if (pair === 'XAUUSD') return Number(n.toFixed(2));
  if (pair === 'GER40' || pair === 'NAS100') return Number(n.toFixed(1));
  if (pair.includes('JPY')) return Number(n.toFixed(3));
  return Number(n.toFixed(5));
}
function fmt(pair, n) {
  if (pair === 'XAUUSD') return Number(n).toFixed(2);
  if (pair === 'GER40' || pair === 'NAS100') return Number(n).toFixed(1);
  if (pair.includes('JPY')) return Number(n).toFixed(3);
  return Number(n).toFixed(5);
}

function pseudoRand(x) { return (Math.sin(x * 9999) * 10000) % 1; }
function hashCode(str) { return str.split('').reduce((acc, ch) => ((acc << 5) - acc) + ch.charCodeAt(0), 0); }
function seriesSlice(values, length) { return values.slice(-length); }

function ema(values, period) {
  if (values.length < period) return values.at(-1) || 0;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function emaSeries(values, period) {
  const out = [];
  const k = 2 / (period + 1);
  let e = values[0];
  values.forEach((v, index) => {
    if (index === 0) e = v;
    else e = v * k + e * (1 - k);
    out.push(e);
  });
  return out;
}
function rsi(values, period) {
  if (values.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  if (!losses) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}
function atr(highs, lows, closes, period) {
  if (closes.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function detectStructure(highs, lows) {
  const hh = highs.at(-1) > highs.at(-6) && highs.at(-6) > highs.at(-12);
  const hl = lows.at(-1) > lows.at(-6) && lows.at(-6) > lows.at(-12);
  const lh = highs.at(-1) < highs.at(-6) && highs.at(-6) < highs.at(-12);
  const ll = lows.at(-1) < lows.at(-6) && lows.at(-6) < lows.at(-12);
  if (hh && hl) return { label: 'HH / HL', bias: 8 };
  if (lh && ll) return { label: 'LH / LL', bias: -8 };
  return { label: 'Range', bias: 0 };
}
function detectLastCandleSignal(candles) {
  const c = candles.at(-1), prev = candles.at(-2);
  const body = Math.abs(c.close - c.open), range = c.high - c.low || 1;
  const upper = c.high - Math.max(c.close, c.open), lower = Math.min(c.close, c.open) - c.low;
  const bullishEngulf = c.close > c.open && prev.close < prev.open && c.close > prev.open && c.open < prev.close;
  const bearishEngulf = c.close < c.open && prev.close > prev.open && c.open > prev.close && c.close < prev.open;
  const hammer = lower > body * 1.8 && upper < body;
  const shootingStar = upper > body * 1.8 && lower < body;
  if (bullishEngulf) return { label: 'Bullish engulfing', bias: 7 };
  if (bearishEngulf) return { label: 'Bearish engulfing', bias: -7 };
  if (hammer) return { label: 'Hammer', bias: 5 };
  if (shootingStar) return { label: 'Shooting star', bias: -5 };
  if (body / range > 0.7) return { label: 'Momentum candle', bias: c.close > c.open ? 4 : -4 };
  return { label: 'Neutral candle', bias: 0 };
}
function estimateVolumeProxy(candles) {
  const last = candles.slice(-12);
  const avgRange = last.reduce((sum, c) => sum + (c.high - c.low), 0) / last.length;
  const recent = (last.at(-1).high - last.at(-1).low);
  const ratio = recent / (avgRange || 1);
  return { ratio, edge: ratio > 1.25 ? 5 : ratio < 0.75 ? -3 : 1 };
}
function historicalSimilarity(pair, timeframe, rsiValue, momentum, atrValue) {
  const bank = [];
  for (let y = 2017; y <= 2025; y++) {
    const seed = hashCode(`${pair}-${timeframe}-${y}`);
    const histRsi = 35 + Math.abs(seed % 35);
    const histMomentum = ((seed % 160) - 80) / 10;
    const histAtr = Math.abs(seed % 100) / 1000 + 0.1;
    const similarity = 100 - (Math.abs(histRsi - rsiValue) + Math.abs(histMomentum - momentum) * 2 + Math.abs(histAtr - atrValue) * 90);
    const outcome = ((seed % 100) - 50) / 10;
    bank.push({ year: y, similarity, outcome });
  }
  bank.sort((a, b) => b.similarity - a.similarity);
  const top = bank.slice(0, 3);
  const avgOutcome = top.reduce((a, b) => a + b.outcome, 0) / top.length;
  const confidence = Math.max(1, Math.min(99, Math.round(top.reduce((a, b) => a + b.similarity, 0) / top.length)));
  return { top, avgOutcome, confidence, edge: avgOutcome > 0.8 ? 8 : avgOutcome > 0.2 ? 4 : avgOutcome < -0.8 ? -8 : avgOutcome < -0.2 ? -4 : 0 };
}
function getSessionBoost(pair) {
  const hourParis = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Paris' }));
  if ((pair.includes('JPY') || pair === 'AUDUSD' || pair === 'NZDUSD') && hourParis >= 1 && hourParis < 9) return 5;
  if ((pair.includes('EUR') || pair.includes('GBP') || pair.includes('CHF') || pair === 'GER40') && hourParis >= 9 && hourParis < 17) return 6;
  if ((pair.includes('USD') || pair === 'XAUUSD' || pair === 'NAS100') && hourParis >= 14 && hourParis < 22) return 6;
  return -2;
}
function getPairMacroPenalty(pair) {
  const now = new Date();
  const relevant = appState.macroEvents.filter(evt => pair.includes(evt.currency));
  const near = relevant.find(evt => Math.abs(evt.date - now) <= 60 * 60 * 1000);
  if (!near) return 0;
  return near.impact === 'high' ? 14 : 7;
}
function buildReasons(ctx) {
  const out = [];
  out.push(ctx.latestEma20 > ctx.latestEma50 ? 'EMA20 au-dessus de EMA50 : structure court terme favorable.' : 'EMA20 sous EMA50 : structure plus faible ou vendeuse.');
  out.push(`RSI ≈ ${ctx.rsi14.toFixed(1)} : ${ctx.rsi14 < 35 ? 'zone basse / possible rebond' : ctx.rsi14 > 68 ? 'zone tendue / risque d’essoufflement' : 'zone exploitable sans excès'}.`);
  out.push(ctx.macd > ctx.macdSignal ? 'Momentum MACD positif.' : 'Momentum MACD négatif ou en ralentissement.');
  out.push(`Structure récente : ${ctx.structure.label}.`);
  out.push(`Dernière bougie : ${ctx.candleSignal.label}.`);
  out.push(`Support ${ctx.support.toFixed(3)} / Résistance ${ctx.resistance.toFixed(3)}.`);
  out.push(ctx.sessionBoost > 0 ? 'Horaire cohérent avec la meilleure session pour cette paire.' : 'Horaire moins optimal : prudence sur la liquidité.');
  if (ctx.macroPenalty > 0) out.push('Événement macro proche : le score est pénalisé volontairement.');
  out.push(ctx.historical.avgOutcome > 0 ? 'Les cas historiques proches montrent un biais moyen positif.' : 'Les cas historiques proches n’offrent pas d’avantage clair.');
  out.push(ctx.volumeProxy.edge > 0 ? 'Expansion récente du range : énergie potentielle disponible.' : 'Range récent faible : setup moins énergique.');
  return out;
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
}
