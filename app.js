const appState = {
  scans: [],
  selectedPair: "EURUSD",

  onlyP1Mode: false,
  autoFocusBestP1: true,
  entrySniperMode: true,
  exitSniperMode: true,

  aiDecisionCache: {}
};

const els = {};

function cacheEls() {
  [
    "pairList",
    "topPriorityTrades",
    "topBlockedTrades",
    "selectedPairName",
    "summaryMetrics",
    "reasonList",
    "tradeSuggestionBox",
    "exitSuggestionBox",
    "onlyP1Btn",
    "autoFocusBtn",
    "entrySniperBtn",
    "exitSniperBtn"
  ].forEach(id => els[id] = document.getElementById(id));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getDecisionPriority(scan) {
  if (scan.blocked) return 0;
  if (scan.signal === "TRADE") return 3;
  if (scan.signal === "WAIT") return 2;
  return 1;
}

function computeEntrySniper(scan) {
  let score = 50;

  if (scan.timingScore > 70) score += 15;
  if (scan.trendScore > 70) score += 15;
  if (scan.rr > 1.5) score += 10;

  return {
    score: clamp(score, 1, 99),
    blocked: score < 60,
    quality: score > 80 ? "elite" : score > 65 ? "good" : "weak"
  };
}

function computeExitSniper(scan) {
  let score = 50;

  if (scan.rr > 1.5) score += 10;
  if (scan.momentum < 0.05) score -= 15;

  return {
    score: clamp(score, 1, 99),
    action: score > 70 ? "TRAIL" : "HOLD"
  };
}

function scanPair(pair) {
  const trendScore = Math.random() * 100;
  const timingScore = Math.random() * 100;
  const riskScore = Math.random() * 100;
  const contextScore = Math.random() * 100;

  const rr = (Math.random() * 2).toFixed(2);

  const entrySniper = computeEntrySniper({
    timingScore,
    trendScore,
    rr
  });

  const exitSniper = computeExitSniper({
    rr,
    momentum: Math.random()
  });

  const finalScore = Math.round(
    trendScore * 0.3 +
    timingScore * 0.3 +
    riskScore * 0.2 +
    contextScore * 0.2
  );

  const blocked = entrySniper.blocked;

  return {
    pair,
    trendScore,
    timingScore,
    riskScore,
    contextScore,
    rr,
    finalScore,
    entrySniper,
    exitSniper,
    signal: blocked ? "NO TRADE" : finalScore > 70 ? "TRADE" : "WAIT",
    blocked,
    confidence: Math.round(finalScore)
  };
}

function refreshAll() {
  const pairs = ["EURUSD","GBPUSD","XAUUSD","USDJPY"];

  appState.scans = pairs.map(scanPair);

  autoSelectBestP1();

  renderTopPriorityTrades();
  renderTopBlockedTrades();
  renderPairList();
  renderSelectedPair();
}

function autoSelectBestP1() {
  if (!appState.autoFocusBestP1) return;

  const best = appState.scans
    .filter(s => getDecisionPriority(s) === 3)
    .sort((a,b)=>b.finalScore-a.finalScore)[0];

  if (best) appState.selectedPair = best.pair;
}

function renderPairList() {
  els.pairList.innerHTML = appState.scans.map(s => `
    <div>${s.pair} - ${s.finalScore}</div>
  `).join("");
}

function renderTopPriorityTrades() {
  const list = appState.scans
    .filter(s => getDecisionPriority(s) === 3)
    .slice(0,3);

  els.topPriorityTrades.innerHTML = list.map(s=>`
    <div>${s.pair} ⭐ ${s.finalScore}</div>
  `).join("");
}

function renderTopBlockedTrades() {
  const list = appState.scans
    .filter(s => s.blocked)
    .slice(0,3);

  els.topBlockedTrades.innerHTML = list.map(s=>`
    <div>${s.pair} ❌</div>
  `).join("");
}

function renderSelectedPair() {
  const scan = appState.scans.find(s=>s.pair===appState.selectedPair);
  if (!scan) return;

  els.selectedPairName.textContent = scan.pair;

  els.summaryMetrics.innerHTML = `
    Score: ${scan.finalScore}<br>
    Entry: ${scan.entrySniper.score}<br>
    Exit: ${scan.exitSniper.score}
  `;

  els.reasonList.innerHTML = `
    <li>Trend ${scan.trendScore}</li>
    <li>Timing ${scan.timingScore}</li>
  `;
}

function bindEvents() {
  els.onlyP1Btn.onclick = () => {
    appState.onlyP1Mode = !appState.onlyP1Mode;
    refreshAll();
  };

  els.autoFocusBtn.onclick = () => {
    appState.autoFocusBestP1 = !appState.autoFocusBestP1;
  };

  els.entrySniperBtn.onclick = () => {
    appState.entrySniperMode = !appState.entrySniperMode;
    refreshAll();
  };

  els.exitSniperBtn.onclick = () => {
    appState.exitSniperMode = !appState.exitSniperMode;
    refreshAll();
  };
}

function init() {
  cacheEls();
  bindEvents();
  refreshAll();
}

init();
