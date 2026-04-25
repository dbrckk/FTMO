import { appState, persistState } from "./state.js";
import { downloadJson, formatPrice, nowIso } from "./utils.js";

export function onAddTrade(event, renderTrades, renderFtmoRisk) {
  event.preventDefault();

  const pair = String(document.getElementById("tradePair")?.value || "EURUSD")
    .trim()
    .toUpperCase();

  const direction = String(document.getElementById("tradeDirection")?.value || "buy")
    .trim()
    .toLowerCase();

  const capital = Number(document.getElementById("tradeCapital")?.value || appState.ftmo?.accountSize || 10000);
  const riskPercent = Number(document.getElementById("riskPercent")?.value || 1);
  const entryInput = Number(document.getElementById("tradeEntry")?.value || 0);
  const notes = String(document.getElementById("tradeNotes")?.value || "").trim();

  const scan = (appState.scans || []).find((item) => item.pair === pair) || null;
  const entry = entryInput || Number(scan?.current || 0);

  const stopLoss = Number(scan?.stopLoss || buildFallbackStop(pair, direction, entry));
  const takeProfit = Number(scan?.takeProfit || buildFallbackTarget(pair, direction, entry, stopLoss));
  const sizing = computePositionSizing(
    {
      pair,
      direction,
      signal: direction === "sell" ? "SELL" : "BUY",
      current: entry,
      stopLoss,
      takeProfit,
      ultraScore: scan?.ultraScore || 0,
      riskScore: scan?.riskScore || 50,
      archiveEdgeScore: scan?.archiveEdgeScore || 50,
      rr: scan?.rr || computeRr(entry, stopLoss, takeProfit, direction)
    },
    capital,
    riskPercent
  );

  const trade = {
    id: `manual_${Date.now()}_${pair}_${Math.random().toString(36).slice(2, 8)}`,
    pair,
    direction,
    status: "active",
    source: "manual",
    openedAt: nowIso(),
    entry,
    stopLoss,
    takeProfit,
    capital,
    riskPercent,
    riskAmount: sizing.riskAmount,
    quantity: sizing.quantity,
    quantityRaw: sizing.quantityRaw,
    leverageLabel: sizing.leverageLabel,
    rr: sizing.rr,
    notes,
    scanSnapshot: scan
      ? {
          timeframe: scan.timeframe,
          ultraScore: scan.ultraScore,
          finalScore: scan.finalScore,
          mlScore: scan.mlScore,
          vectorbtScore: scan.vectorbtScore,
          archiveEdgeScore: scan.archiveEdgeScore,
          tradeStatus: scan.tradeStatus,
          tradeReason: scan.tradeReason
        }
      : null
  };

  appState.trades = Array.isArray(appState.trades) ? appState.trades : [];
  appState.trades.unshift(trade);

  persistState();

  if (typeof renderTrades === "function") renderTrades();
  if (typeof renderFtmoRisk === "function") renderFtmoRisk();
}

export function clearTrades(renderTrades) {
  appState.trades = [];
  persistState();

  if (typeof renderTrades === "function") {
    renderTrades();
  }
}

export function toggleCurrentWatchlist(renderWatchlist) {
  const pair = String(appState.selectedPair || "").toUpperCase();

  if (!pair) return;

  appState.watchlist = Array.isArray(appState.watchlist) ? appState.watchlist : [];

  if (appState.watchlist.includes(pair)) {
    appState.watchlist = appState.watchlist.filter((item) => item !== pair);
  } else {
    appState.watchlist.unshift(pair);
  }

  persistState();

  if (typeof renderWatchlist === "function") {
    renderWatchlist();
  }
}

export function exportTradesJson() {
  downloadJson("ftmo-edge-trades.json", {
    exportedAt: nowIso(),
    trades: appState.trades || [],
    watchlist: appState.watchlist || [],
    paperTrades: appState.paperTrades || [],
    paperArchive: appState.paperArchive || []
  });
}

export function computeDynamicRiskPercent(scan) {
  if (!scan) return 0.25;

  const pair = String(scan.pair || "").toUpperCase();
  const ultra = Number(scan.ultraScore || scan.finalScore || 0);
  const risk = Number(scan.riskScore || 50);
  const archive = Number(scan.archiveEdgeScore || 50);
  const mtf = Number(scan.mtfScore || 0);

  let riskPercent = 0.25;

  if (ultra >= 82) riskPercent = 0.5;
  if (ultra >= 88 && risk >= 58) riskPercent = 0.75;
  if (ultra >= 92 && risk >= 64 && archive >= 58) riskPercent = 1;

  if (ultra < 72) riskPercent = 0.15;
  if (risk < 45) riskPercent = 0.1;
  if (archive < 45) riskPercent *= 0.7;

  if (mtf > 0 && mtf < 60) riskPercent *= 0.6;
  if (mtf >= 82) riskPercent *= 1.1;

  if (pair === "XAUUSD") riskPercent *= 0.85;
  if (pair === "BTCUSD") riskPercent *= 0.65;
  if (pair.startsWith("GBP")) riskPercent *= 0.9;

  return Number(Math.max(0.05, Math.min(1, riskPercent)).toFixed(2));
}

export function computePositionSizing(scan, capital = 10000, forcedRiskPercent = null) {
  const pair = String(scan?.pair || "EURUSD").toUpperCase();
  const direction = String(scan?.direction || "").toLowerCase() || signalToDirection(scan?.signal);
  const entry = Number(scan?.current || scan?.entry || 0);
  const stopLoss = Number(scan?.stopLoss || buildFallbackStop(pair, direction, entry));
  const takeProfit = Number(scan?.takeProfit || buildFallbackTarget(pair, direction, entry, stopLoss));

  const riskPercent = Number.isFinite(Number(forcedRiskPercent))
    ? Number(forcedRiskPercent)
    : computeDynamicRiskPercent(scan);

  const accountCapital = Number(capital || appState.ftmo?.accountSize || 10000);
  const riskAmount = accountCapital * (riskPercent / 100);
  const stopDistance = Math.abs(entry - stopLoss);

  if (!entry || !stopDistance || !Number.isFinite(stopDistance)) {
    return {
      pair,
      riskPercent,
      riskAmount: Number(riskAmount.toFixed(2)),
      quantity: "-",
      quantityRaw: 0,
      stopDistance: 0,
      rr: 0,
      leverageLabel: "invalid stop"
    };
  }

  const rr = computeRr(entry, stopLoss, takeProfit, direction);

  if (pair === "BTCUSD") {
    const btcAmount = riskAmount / stopDistance;
    const notional = btcAmount * entry;
    const leverage = accountCapital > 0 ? notional / accountCapital : 0;

    return {
      pair,
      riskPercent,
      riskAmount: Number(riskAmount.toFixed(2)),
      quantity: `${formatBtcAmount(btcAmount)} BTC`,
      quantityRaw: Number(btcAmount.toFixed(8)),
      stopDistance: Number(stopDistance.toFixed(2)),
      rr,
      notional: Number(notional.toFixed(2)),
      leverageLabel: `${leverage.toFixed(2)}x notional`
    };
  }

  if (pair === "XAUUSD") {
    const ounces = riskAmount / stopDistance;
    const notional = ounces * entry;
    const leverage = accountCapital > 0 ? notional / accountCapital : 0;

    return {
      pair,
      riskPercent,
      riskAmount: Number(riskAmount.toFixed(2)),
      quantity: `${ounces.toFixed(2)} oz`,
      quantityRaw: Number(ounces.toFixed(4)),
      stopDistance: Number(stopDistance.toFixed(2)),
      rr,
      notional: Number(notional.toFixed(2)),
      leverageLabel: `${leverage.toFixed(2)}x notional`
    };
  }

  const units = riskAmount / stopDistance;
  const lots = units / 100000;
  const notional = units * entry;
  const leverage = accountCapital > 0 ? notional / accountCapital : 0;

  return {
    pair,
    riskPercent,
    riskAmount: Number(riskAmount.toFixed(2)),
    quantity: `${lots.toFixed(2)} lots`,
    quantityRaw: Number(lots.toFixed(4)),
    units: Math.round(units),
    stopDistance: Number(stopDistance.toFixed(pair.includes("JPY") ? 3 : 5)),
    rr,
    notional: Number(notional.toFixed(2)),
    leverageLabel: `${leverage.toFixed(2)}x notional`
  };
}

function buildFallbackStop(pair, direction, entry) {
  const p = String(pair || "").toUpperCase();
  const price = Number(entry || 0);

  if (!price) return 0;

  const distance =
    p === "BTCUSD" ? price * 0.006 :
    p === "XAUUSD" ? price * 0.003 :
    p.includes("JPY") ? 0.35 :
    price * 0.002;

  return direction === "sell"
    ? roundByPair(price + distance, p)
    : roundByPair(price - distance, p);
}

function buildFallbackTarget(pair, direction, entry, stopLoss) {
  const p = String(pair || "").toUpperCase();
  const price = Number(entry || 0);
  const stop = Number(stopLoss || 0);

  if (!price || !stop) return 0;

  const rr =
    p === "BTCUSD" ? 2.1 :
    p === "XAUUSD" ? 2.2 :
    2;

  const distance = Math.abs(price - stop);

  return direction === "sell"
    ? roundByPair(price - distance * rr, p)
    : roundByPair(price + distance * rr, p);
}

function computeRr(entry, stopLoss, takeProfit, direction) {
  const price = Number(entry || 0);
  const stop = Number(stopLoss || 0);
  const target = Number(takeProfit || 0);

  const risk = Math.abs(price - stop);
  const reward = Math.abs(target - price);

  if (!risk || !reward) return 0;

  return Number((reward / risk).toFixed(2));
}

function signalToDirection(signal) {
  const raw = String(signal || "").toUpperCase();

  if (raw === "SELL") return "sell";
  if (raw === "BUY") return "buy";

  return "buy";
}

function roundByPair(value, pair) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  if (pair === "XAUUSD" || pair === "BTCUSD") return Number(n.toFixed(2));
  if (String(pair).includes("JPY")) return Number(n.toFixed(3));

  return Number(n.toFixed(5));
}

function formatBtcAmount(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return "0";

  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);

  return n.toFixed(6);
}
