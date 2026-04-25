import { appState, persistState } from "./state.js";
import { saveClosedPaperTrade } from "./api.js";

const DEFAULT_CAPITAL = 10000;

export async function runPaperEngine(scans = []) {
  const engine = appState.paperEngine || {};

  if (!engine.enabled || !engine.autoRun) {
    return {
      ok: true,
      skipped: true,
      reason: "Browser paper engine disabled"
    };
  }

  appState.paperTrades = Array.isArray(appState.paperTrades) ? appState.paperTrades : [];
  appState.paperArchive = Array.isArray(appState.paperArchive) ? appState.paperArchive : [];

  const closed = await updateBrowserPaperTrades(scans);
  const opened = openBrowserPaperTrades(scans);

  persistState();

  return {
    ok: true,
    source: "browser-paper-engine",
    opened,
    closed,
    openTrades: appState.paperTrades.length,
    archivedTrades: appState.paperArchive.length
  };
}

async function updateBrowserPaperTrades(scans) {
  const closed = [];
  const stillOpen = [];

  for (const trade of appState.paperTrades || []) {
    const scan = scans.find((item) => item.pair === trade.pair);

    if (!scan || !scan.current) {
      stillOpen.push({
        ...trade,
        barsHeld: Number(trade.barsHeld || 0) + 1
      });
      continue;
    }

    const price = Number(scan.current);
    const closeResult = shouldCloseTrade(trade, price, scan);

    if (closeResult.close) {
      const closedTrade = buildClosedTrade(trade, closeResult.exitPrice, closeResult.reason, scan);

      closed.push(closedTrade);
      appState.paperArchive.unshift(closedTrade);

      await saveClosedPaperTrade(closedTrade);
    } else {
      stillOpen.push({
        ...trade,
        currentPrice: price,
        livePnlR: computeLivePnlR(trade, price),
        barsHeld: Number(trade.barsHeld || 0) + 1,
        lastUpdatedAt: new Date().toISOString()
      });
    }
  }

  appState.paperTrades = stillOpen;

  return closed;
}

function openBrowserPaperTrades(scans) {
  const engine = appState.paperEngine || {};
  const maxOpenTrades = Number(engine.maxOpenTrades || 4);
  const minUltraScore = Number(engine.minUltraScore || 72);

  const opened = [];

  if ((appState.paperTrades || []).length >= maxOpenTrades) {
    return opened;
  }

  const openPairs = new Set((appState.paperTrades || []).map((trade) => trade.pair));
  const currentRiskGroups = buildRiskGroupsFromTrades(appState.paperTrades || []);

  const candidates = (scans || [])
    .filter((scan) => scan.tradeAllowed)
    .filter((scan) => scan.direction === "buy" || scan.direction === "sell")
    .filter((scan) => Number(scan.ultraScore || 0) >= minUltraScore)
    .filter((scan) => !openPairs.has(scan.pair))
    .filter((scan) => !wouldOverloadRiskGroup(scan.pair, currentRiskGroups))
    .sort((a, b) => {
      const bScore = scorePaperCandidate(b);
      const aScore = scorePaperCandidate(a);
      return bScore - aScore;
    });

  for (const scan of candidates) {
    if ((appState.paperTrades || []).length + opened.length >= maxOpenTrades) break;

    const simulatedGroups = buildRiskGroupsFromTrades([
      ...(appState.paperTrades || []),
      ...opened
    ]);

    if (wouldOverloadRiskGroup(scan.pair, simulatedGroups)) {
      continue;
    }

    const trade = createBrowserPaperTrade(scan, false);

    opened.push(trade);
    openPairs.add(scan.pair);
  }

  if (!opened.length && (appState.paperTrades || []).length === 0) {
    const exploration = (scans || [])
      .filter((scan) => !openPairs.has(scan.pair))
      .filter((scan) => scan.direction === "buy" || scan.direction === "sell")
      .filter((scan) => Number(scan.ultraScore || 0) >= Number(engine.explorationScore || 58))
      .filter((scan) => Number(scan.archiveEdgeScore || 50) >= 48)
      .filter((scan) => !wouldOverloadRiskGroup(scan.pair, currentRiskGroups))
      .sort((a, b) => scorePaperCandidate(b) - scorePaperCandidate(a))[0];

    if (exploration) {
      opened.push(createBrowserPaperTrade(exploration, true));
    }
  }

  appState.paperTrades.unshift(...opened);

  return opened;
}

function createBrowserPaperTrade(scan, exploration = false) {
  const now = new Date();
  const pair = String(scan.pair || "").toUpperCase();

  const riskPercent = exploration
    ? Number(appState.paperEngine?.explorationRiskPerTrade || 0.1)
    : computeBrowserRiskPercent(scan);

  return {
    id: `browser_paper_${Date.now()}_${pair}_${Math.random().toString(36).slice(2, 8)}`,
    pair,
    timeframe: scan.timeframe || appState.timeframe || "M15",
    direction: scan.direction,
    signal: scan.signal,
    status: "open",
    source: exploration ? "browser-paper-exploration" : "browser-paper",
    openedAt: now.toISOString(),
    lastUpdatedAt: now.toISOString(),

    entry: Number(scan.current || 0),
    stopLoss: Number(scan.stopLoss || 0),
    takeProfit: Number(scan.takeProfit || 0),
    currentPrice: Number(scan.current || 0),

    riskPercent,
    rr: Number(scan.rr || 0),
    barsHeld: 0,
    maxBarsHold: exploration
      ? Math.max(5, Number(appState.paperEngine?.maxBarsHold || 12) - 4)
      : Number(appState.paperEngine?.maxBarsHold || 12),

    entryUltraScore: Number(scan.ultraScore || 0),
    ultraScore: Number(scan.ultraScore || 0),
    finalScore: Number(scan.finalScore || 0),
    mlScore: Number(scan.mlScore || 50),
    vectorbtScore: Number(scan.vectorbtScore || 55),
    archiveEdgeScore: Number(scan.archiveEdgeScore || 50),

    mtfScore: Number(scan.mtfScore || 0),
    mtfSignal: scan.mtfSignal || "",
    mtfLabel: scan.mtfLabel || "",

    session: inferSession(now),
    hour: inferHour(now),

    livePnlR: 0,
    modelTag: exploration
      ? `BROWSER_EXPLORATION_${pair}`
      : `BROWSER_${pair}`
  };
}

function shouldCloseTrade(trade, price, scan) {
  const direction = String(trade.direction || "buy").toLowerCase();
  const stop = Number(trade.stopLoss || trade.stop_loss || 0);
  const target = Number(trade.takeProfit || trade.take_profit || 0);
  const barsHeld = Number(trade.barsHeld || trade.bars_held || 0);
  const maxBars = Number(trade.maxBarsHold || trade.max_bars_hold || 12);

  if (direction === "buy") {
    if (price <= stop) return { close: true, reason: "stop-loss", exitPrice: stop };
    if (price >= target) return { close: true, reason: "take-profit", exitPrice: target };
  }

  if (direction === "sell") {
    if (price >= stop) return { close: true, reason: "stop-loss", exitPrice: stop };
    if (price <= target) return { close: true, reason: "take-profit", exitPrice: target };
  }

  if (barsHeld >= maxBars) {
    return { close: true, reason: "time-exit", exitPrice: price };
  }

  if (Number(scan.ultraScore || 0) < 52) {
    return { close: true, reason: "signal-decay", exitPrice: price };
  }

  const scanSignal = String(scan.signal || "").toUpperCase();
  const tradeSignal = direction === "sell" ? "SELL" : "BUY";

  if (
    (tradeSignal === "BUY" && scanSignal === "SELL") ||
    (tradeSignal === "SELL" && scanSignal === "BUY")
  ) {
    return { close: true, reason: "opposite-signal", exitPrice: price };
  }

  return { close: false };
}

function buildClosedTrade(trade, exitPrice, closeReason, scan) {
  const entry = Number(trade.entry || 0);
  const stop = Number(trade.stopLoss || trade.stop_loss || 0);
  const riskDistance = Math.abs(entry - stop);
  const direction = String(trade.direction || "buy").toLowerCase();

  let pnlR = 0;

  if (riskDistance > 0) {
    pnlR =
      direction === "buy"
        ? (Number(exitPrice) - entry) / riskDistance
        : (entry - Number(exitPrice)) / riskDistance;
  }

  const capital = Number(appState.ftmo?.accountSize || DEFAULT_CAPITAL);
  const riskAmount = capital * (Number(trade.riskPercent || 0.25) / 100);
  const pnl = pnlR * riskAmount;

  return {
    id: trade.id,
    pair: trade.pair,
    timeframe: trade.timeframe || appState.timeframe || "M15",
    direction,
    openedAt: trade.openedAt,
    closedAt: new Date().toISOString(),

    entry: roundByPair(entry, trade.pair),
    exitPrice: roundByPair(exitPrice, trade.pair),
    stopLoss: roundByPair(stop, trade.pair),
    takeProfit: roundByPair(trade.takeProfit || trade.take_profit || 0, trade.pair),

    pnl: round(pnl, 2),
    pnlR: round(pnlR, 3),
    win: pnlR > 0 ? 1 : 0,

    riskPercent: Number(trade.riskPercent || 0),
    riskAmount: round(riskAmount, 2),

    session: trade.session || inferSession(new Date()),
    hour: Number(trade.hour || inferHour(new Date())),

    ultraScore: Number(trade.ultraScore || trade.entryUltraScore || scan?.ultraScore || 0),
    mlScore: Number(trade.mlScore || scan?.mlScore || 50),
    vectorbtScore: Number(trade.vectorbtScore || scan?.vectorbtScore || 55),
    archiveEdgeScore: Number(trade.archiveEdgeScore || scan?.archiveEdgeScore || 50),

    mtfScore: Number(trade.mtfScore || scan?.mtfScore || 0),
    mtfSignal: trade.mtfSignal || scan?.mtfSignal || "",

    closeReason,
    source: trade.source || "browser-paper",
    modelTag: trade.modelTag || "BROWSER"
  };
}

function computeLivePnlR(trade, price) {
  const entry = Number(trade.entry || 0);
  const stop = Number(trade.stopLoss || trade.stop_loss || 0);
  const riskDistance = Math.abs(entry - stop);
  const direction = String(trade.direction || "buy").toLowerCase();

  if (!entry || !riskDistance) return 0;

  const pnlR =
    direction === "buy"
      ? (Number(price) - entry) / riskDistance
      : (entry - Number(price)) / riskDistance;

  return round(pnlR, 3);
}

function scorePaperCandidate(scan) {
  return (
    Number(scan.ultraScore || 0) * 0.45 +
    Number(scan.archiveEdgeScore || 50) * 0.20 +
    Number(scan.sessionScore || 50) * 0.13 +
    Number(scan.executionScore || 50) * 0.12 +
    Number(scan.mtfScore || 60) * 0.10
  );
}

function computeBrowserRiskPercent(scan) {
  const pair = String(scan.pair || "").toUpperCase();
  const ultra = Number(scan.ultraScore || 0);
  const risk = Number(scan.riskScore || 50);
  const archive = Number(scan.archiveEdgeScore || 50);
  const mtf = Number(scan.mtfScore || 0);

  let riskPercent = Number(appState.paperEngine?.riskPerTrade || 0.25);

  if (ultra >= 82 && risk >= 52) riskPercent *= 1.25;
  if (ultra >= 88 && risk >= 58 && archive >= 55) riskPercent *= 1.45;
  if (ultra < 72) riskPercent *= 0.65;
  if (risk < 45) riskPercent *= 0.5;
  if (archive < 45) riskPercent *= 0.7;

  if (mtf > 0 && mtf < 60) riskPercent *= 0.55;
  if (mtf >= 82) riskPercent *= 1.1;

  if (pair === "XAUUSD") riskPercent *= 0.85;
  if (pair === "BTCUSD") riskPercent *= 0.65;
  if (pair.startsWith("GBP")) riskPercent *= 0.9;

  return Number(Math.max(0.03, Math.min(0.75, riskPercent)).toFixed(2));
}

function buildRiskGroupsFromTrades(trades) {
  const groups = {};

  for (const trade of trades || []) {
    const pair = String(trade.pair || "").toUpperCase();
    const riskGroups = getPairRiskGroups(pair);

    for (const group of riskGroups) {
      groups[group] = (groups[group] || 0) + 1;
    }
  }

  return groups;
}

function wouldOverloadRiskGroup(pair, currentGroups) {
  const groups = getPairRiskGroups(pair);

  for (const group of groups) {
    const current = Number(currentGroups[group] || 0);

    if (group === "GOLD_USD" && current >= 1) return true;
    if (group === "BTC_USD" && current >= 1) return true;
    if (group === "USD" && current >= 2) return true;
    if (group === "EUR" && current >= 2) return true;
    if (group === "GBP" && current >= 2) return true;
    if (group === "JPY" && current >= 2) return true;
    if (group === "AUD_NZD" && current >= 2) return true;
  }

  return false;
}

function getPairRiskGroups(pair) {
  const p = String(pair || "").toUpperCase();
  const groups = [];

  if (p.includes("USD")) groups.push("USD");
  if (p.includes("EUR")) groups.push("EUR");
  if (p.includes("GBP")) groups.push("GBP");
  if (p.includes("JPY")) groups.push("JPY");
  if (p.includes("AUD") || p.includes("NZD")) groups.push("AUD_NZD");
  if (p === "XAUUSD") groups.push("GOLD_USD");
  if (p === "BTCUSD") groups.push("BTC_USD");

  return groups;
}

export function computePaperAnalytics() {
  const openTrades = Array.isArray(appState.paperTrades) ? appState.paperTrades : [];
  const archive = Array.isArray(appState.paperArchive) ? appState.paperArchive : [];

  const closed = archive.length;
  const wins = archive.filter((trade) => Number(trade.pnlR || 0) > 0).length;
  const losses = Math.max(0, closed - wins);

  const totalPnlR = archive.reduce((sum, trade) => sum + Number(trade.pnlR || 0), 0);
  const netPnl = archive.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);

  const pairStatsMap = {};

  for (const trade of archive) {
    const pair = String(trade.pair || "").toUpperCase();

    if (!pairStatsMap[pair]) {
      pairStatsMap[pair] = {
        pair,
        trades: 0,
        wins: 0,
        pnlR: 0
      };
    }

    pairStatsMap[pair].trades += 1;
    pairStatsMap[pair].wins += Number(trade.pnlR || 0) > 0 ? 1 : 0;
    pairStatsMap[pair].pnlR += Number(trade.pnlR || 0);
  }

  const pairStats = Object.values(pairStatsMap)
    .map((row) => ({
      pair: row.pair,
      trades: row.trades,
      winRate: row.trades ? (row.wins / row.trades) * 100 : 0,
      expectancy: row.trades ? row.pnlR / row.trades : 0
    }))
    .sort((a, b) => Number(b.expectancy || 0) - Number(a.expectancy || 0));

  return {
    openTradesCount: openTrades.length,
    totalClosedTrades: closed,
    wins,
    losses,
    winRate: closed ? (wins / closed) * 100 : 0,
    expectancy: closed ? totalPnlR / closed : 0,
    netPnl,
    pairStats,
    recentTrades: archive.slice(0, 12)
  };
}

function inferSession(date = new Date()) {
  const hour = inferHour(date);

  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const tokyo = hour >= 1 && hour < 10;

  if (london && newYork) return "London+NewYork";
  if (london) return "London";
  if (newYork) return "NewYork";
  if (tokyo) return "Tokyo";

  return "OffSession";
}

function inferHour(date = new Date()) {
  return Number(
    new Date(date).toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );
}

function roundByPair(value, pair) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  const p = String(pair || "").toUpperCase();

  if (p === "XAUUSD" || p === "BTCUSD") return Number(n.toFixed(2));
  if (p.includes("JPY")) return Number(n.toFixed(3));

  return Number(n.toFixed(5));
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Number(n.toFixed(digits));
}
