export async function runPaperEngine(scans = []) {
  if (!Array.isArray(scans)) return;
  if (!appState.paperEngine?.enabled) return;

  ensurePaperState();

  await updateOpenPaperTrades(scans);
  openNewPaperTrades(scans);

  trimPaperState();
  persistState();
}

export function computePaperAnalytics() {
  ensurePaperState();

  const archive = Array.isArray(appState.paperArchive) ? appState.paperArchive : [];
  const openTrades = Array.isArray(appState.paperTrades) ? appState.paperTrades : [];

  const total = archive.length;
  const wins = archive.filter((t) => Number(t.pnlR || 0) > 0).length;
  const losses = total - wins;
  const winRate = total ? (wins / total) * 100 : 0;
  const expectancy = total
    ? archive.reduce((sum, t) => sum + Number(t.pnlR || 0), 0) / total
    : 0;
  const netPnl = archive.reduce((sum, t) => sum + Number(t.pnl || 0), 0);

  const pairMap = {};

  for (const trade of archive) {
    if (!pairMap[trade.pair]) {
      pairMap[trade.pair] = {
        pair: trade.pair,
        trades: 0,
        wins: 0,
        pnlR: 0,
        pnl: 0
      };
    }

    pairMap[trade.pair].trades += 1;
    pairMap[trade.pair].pnlR += Number(trade.pnlR || 0);
    pairMap[trade.pair].pnl += Number(trade.pnl || 0);

    if (Number(trade.pnlR || 0) > 0) {
      pairMap[trade.pair].wins += 1;
    }
  }

  const pairStats = Object.values(pairMap)
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

import { appState, persistState } from "./state.js";
import { saveClosedPaperTrade } from "./api.js";

function ensurePaperState() {
  if (!Array.isArray(appState.paperTrades)) appState.paperTrades = [];
  if (!Array.isArray(appState.paperArchive)) appState.paperArchive = [];
  if (!Array.isArray(appState.tradeArchive)) appState.tradeArchive = [];
  if (!appState.paperEngine) {
    appState.paperEngine = {
      enabled: true,
      autoRun: true,
      maxOpenTrades: 4,
      riskPerTrade: 0.25,
      minUltraScore: 72,
      explorationRiskPerTrade: 0.1,
      refreshIntervalMs: 20000,
      maxBarsHold: 12
    };
  }
}

function trimPaperState() {
  appState.paperTrades = appState.paperTrades.slice(-200);
  appState.paperArchive = appState.paperArchive.slice(-4000);
  appState.tradeArchive = appState.tradeArchive.slice(-4000);
}

async function updateOpenPaperTrades(scans) {
  const stillOpen = [];
  const closedToPersist = [];

  for (const trade of appState.paperTrades) {
    const scan = scans.find((s) => s.pair === trade.pair);

    if (!scan) {
      stillOpen.push({
        ...trade,
        barsHeld: Number(trade.barsHeld || 0) + 1,
        updatedAt: new Date().toISOString()
      });
      continue;
    }

    const updated = {
      ...trade,
      currentPrice: Number(scan.current || trade.currentPrice || trade.entry || 0),
      currentUltraScore: Number(scan.ultraScore || trade.entryUltraScore || 0),
      currentTradeStatus: scan.tradeStatus || trade.currentTradeStatus || "WAIT",
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

  appState.paperTrades = stillOpen;

  if (closedToPersist.length) {
    await Promise.allSettled(closedToPersist.map((trade) => saveClosedPaperTrade(trade)));
  }
}

function openNewPaperTrades(scans) {
  const engine = appState.paperEngine || {};
  const maxOpenTrades = Number(engine.maxOpenTrades || 4);
  const minUltraScore = Number(engine.minUltraScore || 72);
  const openPairs = new Set(appState.paperTrades.map((t) => t.pair));

  if (appState.paperTrades.length >= maxOpenTrades) return;

  const allowedCandidates = [...scans]
    .filter((scan) => scan.tradeAllowed)
    .filter((scan) => Number(scan.ultraScore || 0) >= minUltraScore)
    .filter((scan) => scan.signal === "BUY" || scan.signal === "SELL")
    .filter((scan) => !openPairs.has(scan.pair))
    .sort((a, b) => {
      const aScore = Number(a.ultraScore || a.finalScore || 0);
      const bScore = Number(b.ultraScore || b.finalScore || 0);
      if (bScore !== aScore) return bScore - aScore;
      return Number(b.archiveEdgeScore || 0) - Number(a.archiveEdgeScore || 0);
    });

  for (const scan of allowedCandidates) {
    if (appState.paperTrades.length >= maxOpenTrades) break;
    appState.paperTrades.push(createPaperTradeFromScan(scan, false));
    openPairs.add(scan.pair);
  }

  if (appState.paperTrades.length === 0) {
    const exploration = [...scans]
      .filter((scan) => !openPairs.has(scan.pair))
      .filter((scan) => Number(scan.ultraScore || scan.finalScore || 0) >= 55)
      .sort((a, b) => Number(b.ultraScore || b.finalScore || 0) - Number(a.ultraScore || a.finalScore || 0))[0];

    if (exploration) {
      appState.paperTrades.push(createPaperTradeFromScan(exploration, true));
    }
  }
}

function createPaperTradeFromScan(scan, explorationMode = false) {
  const now = new Date();
  const direction = scan.signal === "SELL" ? "sell" : "buy";
  const entry = Number(scan.current || 0);

  let riskDistance = Math.abs(entry - Number(scan.stopLoss || 0));
  if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
    const atrValue = Number(scan.atr14 || 0);
    riskDistance = atrValue > 0 ? atrValue * 1.4 : entry * 0.002;
  }

  const rr = Math.max(1.2, Number(scan.rr || 1.8));

  const stopLoss =
    direction === "buy"
      ? entry - riskDistance
      : entry + riskDistance;

  const takeProfit =
    direction === "buy"
      ? entry + riskDistance * rr
      : entry - riskDistance * rr;

  return {
    id: `paper_${Date.now()}_${scan.pair}_${Math.random().toString(36).slice(2, 8)}`,
    pair: scan.pair,
    timeframe: scan.timeframe,
    direction,
    entry,
    stopLoss: roundByPair(stopLoss, scan.pair),
    takeProfit: roundByPair(takeProfit, scan.pair),
    currentPrice: entry,
    openedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "open",
    entryUltraScore: Number(scan.ultraScore || 0),
    entryFinalScore: Number(scan.finalScore || 0),
    entryMlScore: Number(scan.mlScore || 0),
    entryVectorbtScore: Number(scan.vectorbtScore || 0),
    entryArchiveEdgeScore: Number(scan.archiveEdgeScore || 0),
    rr: Number(rr.toFixed(2)),
    barsHeld: 0,
    maxBarsHold: Number(appState.paperEngine?.maxBarsHold || 12),
    riskPercent: explorationMode
      ? Number(appState.paperEngine?.explorationRiskPerTrade || 0.1)
      : Number(appState.paperEngine?.riskPerTrade || 0.25),
    session: inferSession(now),
    hour: inferHour(now),
    modelTag: explorationMode ? "EXPLORATION" : (scan.tradeStatus || "PAPER"),
    closeReason: "",
    source: scan.source || "scanner",
    pairSnapshot: {
      ultraScore: Number(scan.ultraScore || 0),
      tradeStatus: scan.tradeStatus || "",
      tradeReason: scan.tradeReason || "",
      archivePairWinRate: Number(scan.archiveStats?.pairWinRate || 50),
      archivePairExpectancy: Number(scan.archiveStats?.pairExpectancy || 0),
      sameDirectionWinRate: Number(scan.archiveStats?.sameDirectionWinRate || 50),
      sameDirectionExpectancy: Number(scan.archiveStats?.sameDirectionExpectancy || 0)
    }
  };
}

function shouldClosePaperTrade(trade, scan) {
  const price = Number(scan.current || trade.currentPrice || trade.entry || 0);
  const stop = Number(trade.stopLoss || 0);
  const target = Number(trade.takeProfit || 0);

  if (trade.direction === "buy") {
    if (price <= stop) {
      return { close: true, reason: "stop-loss", exitPrice: stop };
    }
    if (price >= target) {
      return { close: true, reason: "take-profit", exitPrice: target };
    }
  } else {
    if (price >= stop) {
      return { close: true, reason: "stop-loss", exitPrice: stop };
    }
    if (price <= target) {
      return { close: true, reason: "take-profit", exitPrice: target };
    }
  }

  if (Number(trade.barsHeld || 0) >= Number(trade.maxBarsHold || 12)) {
    return { close: true, reason: "time-exit", exitPrice: price };
  }

  if (!scan.tradeAllowed && Number(scan.ultraScore || 0) < 60) {
    return { close: true, reason: "signal-decay", exitPrice: price };
  }

  if (trade.modelTag === "EXPLORATION" && Number(scan.ultraScore || 0) < 52) {
    return { close: true, reason: "exploration-invalidated", exitPrice: price };
  }

  return { close: false };
}

function finalizePaperTrade(trade, scan, closeResult) {
  const closedAt = new Date().toISOString();
  const exitPrice = Number(closeResult.exitPrice || scan.current || trade.currentPrice || trade.entry || 0);

  const riskDistance = Math.abs(Number(trade.entry || 0) - Number(trade.stopLoss || 0));
  let pnlR = 0;

  if (riskDistance > 0) {
    if (trade.direction === "buy") {
      pnlR = (exitPrice - Number(trade.entry || 0)) / riskDistance;
    } else {
      pnlR = (Number(trade.entry || 0) - exitPrice) / riskDistance;
    }
  }

  const capital = Number(appState.ftmo?.accountSize || 10000);
  const riskAmount = capital * (Number(trade.riskPercent || 0.25) / 100);
  const pnl = pnlR * riskAmount;

  return {
    ...trade,
    status: "closed",
    closedAt,
    exitPrice: roundByPair(exitPrice, trade.pair),
    currentPrice: roundByPair(exitPrice, trade.pair),
    pnlR: Number(pnlR.toFixed(3)),
    pnl: Number(pnl.toFixed(2)),
    win: pnlR > 0 ? 1 : 0,
    closeReason: closeResult.reason,
    finalUltraScore: Number(scan.ultraScore || trade.entryUltraScore || 0),
    finalSignal: scan.signal || "WAIT",
    finalTradeStatus: scan.tradeStatus || "WAIT"
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

function roundByPair(value, pair) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (pair === "XAUUSD") return Number(n.toFixed(2));
  if (String(pair).includes("JPY")) return Number(n.toFixed(3));
  return Number(n.toFixed(5));
    }
