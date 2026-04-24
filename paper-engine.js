import { appState, persistState } from "./state.js";
import { saveClosedPaperTrade } from "./api.js";

export async function runPaperEngine(scans = []) {
  if (!appState.paperEngine?.enabled) return;

  await updateOpenPaperTrades(scans);
  openNewPaperTrades(scans);

  persistState();
}

async function updateOpenPaperTrades(scans) {
  if (!Array.isArray(appState.paperTrades)) appState.paperTrades = [];
  if (!Array.isArray(appState.paperArchive)) appState.paperArchive = [];

  const stillOpen = [];
  const closedToPersist = [];

  for (const trade of appState.paperTrades) {
    const scan = scans.find((s) => s.pair === trade.pair);
    if (!scan) {
      stillOpen.push(trade);
      continue;
    }

    const updated = {
      ...trade,
      currentPrice: Number(scan.current || trade.currentPrice || trade.entry),
      currentUltraScore: Number(scan.ultraScore || trade.entryUltraScore || 0),
      barsHeld: Number(trade.barsHeld || 0) + 1,
      updatedAt: new Date().toISOString()
    };

    const closeResult = shouldClosePaperTrade(updated, scan);

    if (closeResult.close) {
      const closedTrade = finalizePaperTrade(updated, scan, closeResult);
      appState.paperArchive.push(closedTrade);
      appState.tradeArchive.push({
        id: closedTrade.id,
        pair: closedTrade.pair,
        direction: closedTrade.direction,
        openedAt: closedTrade.openedAt,
        closedAt: closedTrade.closedAt,
        pnlR: closedTrade.pnlR,
        pnl: closedTrade.pnl,
        win: closedTrade.win,
        session: closedTrade.session,
        hour: closedTrade.hour,
        strategyTag: closedTrade.modelTag || "paper-engine",
        notes: closedTrade.closeReason
      });
      closedToPersist.push(closedTrade);
    } else {
      stillOpen.push(updated);
    }
  }

  appState.paperTrades = stillOpen.slice(-200);
  appState.paperArchive = appState.paperArchive.slice(-4000);
  appState.tradeArchive = appState.tradeArchive.slice(-4000);

  await Promise.all(closedToPersist.map((trade) => saveClosedPaperTrade(trade)));
}

function openNewPaperTrades(scans) {
  if (!Array.isArray(appState.paperTrades)) appState.paperTrades = [];

  const engine = appState.paperEngine || {};
  const maxOpenTrades = Number(engine.maxOpenTrades || 4);
  const minUltraScore = Number(engine.minUltraScore || 72);

  const openPairs = new Set(appState.paperTrades.map((t) => t.pair));

  const allowedCandidates = [...scans]
    .filter((scan) => scan.tradeAllowed)
    .filter((scan) => Number(scan.ultraScore || 0) >= minUltraScore)
    .filter((scan) => scan.signal === "BUY" || scan.signal === "SELL")
    .filter((scan) => !openPairs.has(scan.pair))
    .sort((a, b) => Number(b.ultraScore || 0) - Number(a.ultraScore || 0));

  for (const scan of allowedCandidates) {
    if (appState.paperTrades.length >= maxOpenTrades) break;
    appState.paperTrades.push(createPaperTradeFromScan(scan, false));
  }

  if (appState.paperTrades.length === 0) {
    const exploration = [...scans]
      .filter((scan) => !openPairs.has(scan.pair))
      .sort((a, b) => Number(b.ultraScore || b.finalScore || 0) - Number(a.ultraScore || a.finalScore || 0))[0];

    if (exploration) {
      appState.paperTrades.push(createPaperTradeFromScan(exploration, true));
    }
  }
}

function createPaperTradeFromScan(scan, explorationMode = false) {
  const now = new Date();

  return {
    id: `paper_${Date.now()}_${scan.pair}_${Math.random().toString(36).slice(2, 8)}`,
    pair: scan.pair,
    timeframe: scan.timeframe,
    direction: scan.signal === "SELL" ? "sell" : "buy",
    entry: Number(scan.current || 0),
    stopLoss: Number(scan.stopLoss || 0),
    takeProfit: Number(scan.takeProfit || 0),
    currentPrice: Number(scan.current || 0),
    openedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "open",
    entryUltraScore: Number(scan.ultraScore || 0),
    entryFinalScore: Number(scan.finalScore || 0),
    entryMlScore: Number(scan.mlScore || 0),
    entryVectorbtScore: Number(scan.vectorbtScore || 0),
    entryArchiveEdgeScore: Number(scan.archiveEdgeScore || 0),
    rr: Number(scan.rr || 0),
    barsHeld: 0,
    maxBarsHold: Number(appState.paperEngine?.maxBarsHold || 12),
    riskPercent: explorationMode
      ? Number(appState.paperEngine?.explorationRiskPerTrade || 0.10)
      : Number(appState.paperEngine?.riskPerTrade || 0.25),
    session: inferSession(now),
    hour: inferHour(now),
    modelTag: explorationMode ? "EXPLORATION" : (scan.tradeStatus || "PAPER"),
    closeReason: ""
  };
}

function shouldClosePaperTrade(trade, scan) {
  const price = Number(scan.current || trade.currentPrice || trade.entry);

  if (trade.direction === "buy") {
    if (price <= Number(trade.stopLoss || 0)) {
      return { close: true, reason: "stop-loss", exitPrice: Number(trade.stopLoss || price) };
    }
    if (price >= Number(trade.takeProfit || 0)) {
      return { close: true, reason: "take-profit", exitPrice: Number(trade.takeProfit || price) };
    }
  } else {
    if (price >= Number(trade.stopLoss || 0)) {
      return { close: true, reason: "stop-loss", exitPrice: Number(trade.stopLoss || price) };
    }
    if (price <= Number(trade.takeProfit || 0)) {
      return { close: true, reason: "take-profit", exitPrice: Number(trade.takeProfit || price) };
    }
  }

  if (Number(trade.barsHeld || 0) >= Number(trade.maxBarsHold || 12)) {
    return { close: true, reason: "time-exit", exitPrice: price };
  }

  if (!scan.tradeAllowed && Number(scan.ultraScore || 0) < 60) {
    return { close: true, reason: "signal-decay", exitPrice: price };
  }

  return { close: false };
}

function finalizePaperTrade(trade, scan, closeResult) {
  const closedAt = new Date().toISOString();
  const exitPrice = Number(closeResult.exitPrice || scan.current || trade.currentPrice || trade.entry);

  const riskDistance =
    trade.direction === "buy"
      ? Math.abs(Number(trade.entry || 0) - Number(trade.stopLoss || 0))
      : Math.abs(Number(trade.stopLoss || 0) - Number(trade.entry || 0));

  let pnlR = 0;

  if (riskDistance > 0) {
    if (trade.direction === "buy") {
      pnlR = (exitPrice - Number(trade.entry || 0)) / riskDistance;
    } else {
      pnlR = (Number(trade.entry || 0) - exitPrice) / riskDistance;
    }
  }

  const capital = Number(appState.ftmo?.accountSize || 10000);
  const riskAmount = capital * ((Number(trade.riskPercent || 0.25)) / 100);
  const pnl = pnlR * riskAmount;

  return {
    ...trade,
    status: "closed",
    closedAt,
    exitPrice,
    currentPrice: exitPrice,
    pnlR: Number(pnlR.toFixed(3)),
    pnl: Number(pnl.toFixed(2)),
    win: pnlR > 0 ? 1 : 0,
    closeReason: closeResult.reason,
    finalUltraScore: Number(scan.ultraScore || trade.entryUltraScore || 0),
    finalSignal: scan.signal || "WAIT"
  };
}

export function computePaperAnalytics() {
  const archive = Array.isArray(appState.paperArchive) ? appState.paperArchive : [];
  const openTrades = Array.isArray(appState.paperTrades) ? appState.paperTrades : [];

  const total = archive.length;
  const wins = archive.filter((t) => Number(t.pnlR || 0) > 0).length;
  const losses = archive.filter((t) => Number(t.pnlR || 0) <= 0).length;
  const winRate = total ? (wins / total) * 100 : 0;
  const expectancy = total
    ? archive.reduce((sum, t) => sum + Number(t.pnlR || 0), 0) / total
    : 0;
  const netPnl = archive.reduce((sum, t) => sum + Number(t.pnl || 0), 0);

  const byPairMap = {};

  for (const trade of archive) {
    if (!byPairMap[trade.pair]) {
      byPairMap[trade.pair] = {
        pair: trade.pair,
        trades: 0,
        wins: 0,
        pnlR: 0,
        pnl: 0
      };
    }

    byPairMap[trade.pair].trades += 1;
    byPairMap[trade.pair].pnlR += Number(trade.pnlR || 0);
    byPairMap[trade.pair].pnl += Number(trade.pnl || 0);
    if (Number(trade.pnlR || 0) > 0) byPairMap[trade.pair].wins += 1;
  }

  const pairStats = Object.values(byPairMap)
    .map((row) => ({
      ...row,
      winRate: row.trades ? (row.wins / row.trades) * 100 : 0,
      expectancy: row.trades ? row.pnlR / row.trades : 0
    }))
    .sort((a, b) => Number(b.expectancy || 0) - Number(a.expectancy || 0));

  return {
    openTradesCount: openTrades.length,
    totalClosedTrades: total,
    wins,
    losses,
    winRate: Number(winRate.toFixed(1)),
    expectancy: Number(expectancy.toFixed(3)),
    netPnl: Number(netPnl.toFixed(2)),
    bestPair: pairStats[0] || null,
    worstPair: pairStats.at(-1) || null,
    pairStats,
    recentTrades: [...archive].slice(-20).reverse()
  };
}

function inferSession(date = new Date()) {
  const hour = inferHour(date);
  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const overlap = london && newYork;
  const asia = hour >= 1 && hour < 10;

  if (overlap) return "London+NewYork";
  if (london) return "London";
  if (newYork) return "NewYork";
  if (asia) return "Tokyo";
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
