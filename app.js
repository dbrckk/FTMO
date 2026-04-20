const PAIRS = [
  { symbol: "EURUSD", tier: 1 },
  { symbol: "GBPUSD", tier: 1 },
  { symbol: "USDJPY", tier: 1 },
  { symbol: "USDCHF", tier: 1 },
  { symbol: "USDCAD", tier: 1 },
  { symbol: "AUDUSD", tier: 1 },
  { symbol: "NZDUSD", tier: 1 },
  { symbol: "EURGBP", tier: 1 },

  { symbol: "EURJPY", tier: 2 },
  { symbol: "GBPJPY", tier: 2 },
  { symbol: "AUDJPY", tier: 2 },

  { symbol: "XAUUSD", tier: 2 },
  { symbol: "NAS100", tier: 2 },
  { symbol: "GER40", tier: 2 }
];

let appState = {
  scans: [],
  selectedPair: "EURUSD",
  trades: [],
  ftmoRisk: null
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheEls();
  setupChart();
  refreshAll();
});

function cacheEls() {
  [
    "pairList","pairCount","pairSearch",
    "selectedPairName","selectedSignalBadge",
    "summaryMetrics","reasonList","gatekeeperBox",
    "tradeForm","tradePair","tradeDirection",
    "tradeCapital","tradeEntry","riskPercent",
    "tradeNotes","tradeSuggestionBox",
    "chart",
    "ftmoDecisionBadge","ftmoDailyRemaining",
    "ftmoMaxAdditionalRisk","ftmoDecisionText","ftmoDecisionReason"
  ].forEach(id => els[id] = document.getElementById(id));
}

async function refreshAll() {
  const scans = await Promise.all(
    PAIRS.map(p => scanPair(p))
  );

  appState.scans = scans.sort((a,b)=>b.score-a.score);
  renderPairs();
  renderSelected();
  await fetchFtmo();
}

async function scanPair(pair) {
  const res = await fetch(`/api/market-data?pair=${pair.symbol}&timeframe=M15`);
  const data = await res.json();

  const score = Math.random()*100;

  return {
    pair: pair.symbol,
    candles: data.candles,
    price: data.price,
    score
  };
}

function renderPairs() {
  els.pairList.innerHTML = "";

  appState.scans.forEach(s=>{
    const div = document.createElement("div");
    div.innerHTML = `${s.pair} - ${Math.round(s.score)}`;
    div.onclick = ()=> {
      appState.selectedPair = s.pair;
      renderSelected();
    };
    els.pairList.appendChild(div);
  });
}

function renderSelected() {
  const s = appState.scans.find(x=>x.pair===appState.selectedPair);
  if(!s) return;

  els.selectedPairName.textContent = s.pair;
  renderChart(s.candles);
}

async function fetchFtmo() {
  const res = await fetch("/api/risk-engine",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      accountSize:10000,
      requestedRiskPercent:1,
      openRiskPercent:0
    })
  });

  const data = await res.json();
  appState.ftmoRisk = data;

  els.ftmoDecisionBadge.textContent = data.allowed?"OK":"BLOCK";
  els.ftmoDailyRemaining.textContent = data.remainingDailyLoss;
  els.ftmoMaxAdditionalRisk.textContent = data.maxAdditionalRiskPercent;
  els.ftmoDecisionText.textContent = data.decision;
  els.ftmoDecisionReason.textContent = data.reason;
}

let chart, candleSeries;

function setupChart() {
  chart = LightweightCharts.createChart(els.chart,{
    width:400,height:300
  });
  candleSeries = chart.addCandlestickSeries();
}

function renderChart(candles) {
  candleSeries.setData(candles);
}
