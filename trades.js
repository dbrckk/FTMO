import { appState, persistState } from "./state.js";

export function computeDynamicRiskPercent(scan) {
  const ftmo = appState.ftmo || {};
  const requested = Number(ftmo.requestedRiskPercent || 1);

  const ultra = Number(scan?.ultraScore || scan?.finalScore || 50);
  const archiveEdge = Number(scan?.archiveEdgeScore || 50);
  const execution = Number(scan?.executionScore || 50);
  const session = Number(scan?.sessionScore || 50);
  const isGold = scan?.pair === "XAUUSD";

  let risk = requested;

  if (ultra >= 85) risk = Math.min(requested, 1.0);
  else if (ultra >= 78) risk = Math.min(requested, 0.8);
  else if (ultra >= 70) risk = Math.min(requested, 0.6);
  else if (ultra >= 62) risk = Math.min(requested, 0.4);
  else risk = Math.min(requested, 0.25);

  if (archiveEdge >= 68) risk += 0.1;
  if (execution >= 68) risk += 0.05;
  if (session < 52) risk -= 0.1;

  if (isGold) {
    risk -= 0.05;
    if (Number(scan?.goldDangerScore || 0) >= 58) {
      risk -= 0.1;
    }
    if (Number(scan?.goldStructureScore || 0) >= 72) {
      risk += 0.05;
    }
  }

  const remaining = getRemainingFtmoRiskPercent();
  risk = Math.min(risk, remaining);
  risk = Math.max(0.1, risk);

  return Number(risk.toFixed(2));
}

export function computePositionSizing(scan, capitalInput) {
  const capital = Number(capitalInput || appState.ftmo?.accountSize || 10000);
  const riskPercent = computeDynamicRiskPercent(scan);
  const riskAmount = capital * (riskPercent / 100);

  const entry = Number(scan?.current || 0);
  const stop = Number(scan?.stopLoss || 0);
  let stopDistance = Math.abs(entry - stop);

  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    const atrValue = Number(scan?.atr14 || 0);
    stopDistance = atrValue > 0 ? atrValue * 1.4 : entry * 0.002;
  }

  const quantity = stopDistance > 0 ? riskAmount / stopDistance : 0;

  let leverageLabel = "Normal";
  if (quantity > 0) {
    if (scan?.pair === "XAUUSD") leverageLabel = "Gold scaled";
    else if (String(scan?.pair || "").includes("JPY")) leverageLabel = "JPY scaled";
  }

  return {
    capital: Number(capital.toFixed(2)),
    riskPercent,
    riskAmount: Number(riskAmount.toFixed(2)),
    stopDistance: Number(stopDistance.toFixed(5)),
    quantity: Number(quantity.toFixed(2)),
    leverageLabel
  };
}

export function onAddTrade(event, renderTrades, renderFtmoRisk) {
  event.preventDefault();

  const pair = String(document.getElementById("tradePair")?.value || "").toUpperCase().trim();
  const direction = String(document.getElementById("tradeDirection")?.value || "buy").toLowerCase();
  const capital = Number(document.getElementById("tradeCapital")?.value || appState.ftmo?.accountSize || 10000);
  const riskPercent = Number(document.getElementById("riskPercent")?.value || appState.ftmo?.requestedRiskPercent || 1);
  const entry = Number(document.getElementById("tradeEntry")?.value || 0);
  const notes = String(document.getElementById("tradeNotes")?.value || "").trim();

  if (!pair || !Number.isFinite(entry) || entry <= 0) {
    return;
  }

  const scan = (appState.scans || []).find((s) => s.pair === pair);

  const stopLoss = Number(scan?.stopLoss || deriveFallbackStop(entry, pair, direction));
  const takeProfit = Number(scan?.takeProfit || deriveFallbackTarget(entry, stopLoss, direction, 2));
  const rr = computeRR(entry, stopLoss, takeProfit, direction);

  const trade = {
    id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    pair,
    direction,
    capital: Number(capital.toFixed(2)),
    riskPercent: Number(riskPercent.toFixed(2)),
    entry: roundByPair(entry, pair),
    stopLoss: roundByPair(stopLoss, pair),
    takeProfit: roundByPair(takeProfit, pair),
    rr: Number(rr.toFixed(2)),
    status: "active",
    notes,
    createdAt: new Date().toISOString(),
    ultraScore: Number(scan?.ultraScore || 0),
    tradeStatus: scan?.tradeStatus || "",
    archiveEdgeScore: Number(scan?.archiveEdgeScore || 0)
  };

  appState.trades.unshift(trade);
  appState.trades = appState.trades.slice(0, 200);
  persistState();

  if (typeof renderTrades === "function") renderTrades();
  if (typeof renderFtmoRisk === "function") renderFtmoRisk();
}

export function clearTrades(renderTrades) {
  appState.trades = [];
  persistState();
  if (typeof renderTrades === "function") renderTrades();
}

export function toggleCurrentWatchlist(renderWatchlist) {
  const pair = appState.selectedPair;
  if (!pair) return;

  if (!Array.isArray(appState.watchlist)) {
    appState.watchlist = [];
  }

  const exists = appState.watchlist.includes(pair);

  if (exists) {
    appState.watchlist = appState.watchlist.filter((p) => p !== pair);
  } else {
    appState.watchlist.unshift(pair);
    appState.watchlist = [...new Set(appState.watchlist)].slice(0, 50);
  }

  persistState();
  if (typeof renderWatchlist === "function") renderWatchlist();
}

export function exportTradesJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    activeTrades: appState.trades || [],
    paperTrades: appState.paperTrades || [],
    paperArchive: appState.paperArchive || [],
    tradeArchive: appState.tradeArchive || []
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ftmo-trades-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getRemainingFtmoRiskPercent() {
  const ftmo = appState.ftmo || {};
  const accountSize = Number(ftmo.accountSize || 10000);
  const dailyLossLimitPercent = Number(ftmo.dailyLossLimitPercent || 5);
  const closedTodayPnl = Number(ftmo.closedTodayPnl || 0);

  const remainingDollar =
    (accountSize * dailyLossLimitPercent / 100) -
    Math.abs(closedTodayPnl);

  if (remainingDollar <= 0) return 0.1;

  return Number(((remainingDollar / accountSize) * 100).toFixed(2));
}

function deriveFallbackStop(entry, pair, direction) {
  const baseDistance =
    pair === "XAUUSD"
      ? 6
      : String(pair).includes("JPY")
        ? 0.35
        : 0.0035;

  return direction === "sell" ? entry + baseDistance : entry - baseDistance;
}

function deriveFallbackTarget(entry, stopLoss, direction, rr = 2) {
  const riskDistance = Math.abs(entry - stopLoss);
  if (direction === "sell") {
    return entry - riskDistance * rr;
  }
  return entry + riskDistance * rr;
}

function computeRR(entry, stopLoss, takeProfit, direction) {
  const risk =
    direction === "sell"
      ? Math.abs(stopLoss - entry)
      : Math.abs(entry - stopLoss);

  const reward =
    direction === "sell"
      ? Math.abs(entry - takeProfit)
      : Math.abs(takeProfit - entry);

  if (!Number.isFinite(risk) || risk <= 0) return 0;
  return reward / risk;
}

function roundByPair(value, pair) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (pair === "XAUUSD") return Number(n.toFixed(2));
  if (String(pair).includes("JPY")) return Number(n.toFixed(3));
  return Number(n.toFixed(5));
                     }
