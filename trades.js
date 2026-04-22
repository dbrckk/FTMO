// trades.js

import { appState, persistState, els } from "./state.js";
import { fetchPortfolioRisk } from "./api.js";

export async function onAddTrade(e, renderTrades, renderFtmoRisk) {
  e.preventDefault();

  const pair = document.getElementById("tradePair")?.value;
  const direction = document.getElementById("tradeDirection")?.value || "buy";
  const capital = Number(
    document.getElementById("tradeCapital")?.value ||
    appState.ftmo.accountSize ||
    10000
  );
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

export function clearTrades(renderTrades) {
  appState.trades = [];
  persistState();
  renderTrades();
}

export function toggleCurrentWatchlist(renderWatchlist) {
  if (!appState.selectedPair) return;

  if (appState.watchlist.includes(appState.selectedPair)) {
    appState.watchlist = appState.watchlist.filter(
      (p) => p !== appState.selectedPair
    );
  } else {
    appState.watchlist.push(appState.selectedPair);
  }

  persistState();
  renderWatchlist();
}

export function exportTradesJson() {
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

export function computeDynamicRiskPercent(scan) {
  let risk = 0.5;

  if ((scan.finalScore || 0) > 85) risk = 1.0;
  if ((scan.mlScore || 0) > 80) risk += 0.2;
  if ((scan.vectorbtScore || 0) > 80) risk += 0.2;

  return Math.min(risk, 1.5);
}

export function computeDynamicLeverageLabel(scan) {
  const score = Number(scan.finalScore || 0);

  if (score >= 85) return "HIGH QUALITY";
  if (score >= 70) return "MEDIUM QUALITY";
  return "DEFENSIVE";
}

export function computePositionSizing(scan, capital) {
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
