import { appState, persistState } from "./state.js";
import { saveClosedPaperTrade } from "./api.js";

const DEFAULT_CAPITAL = 10000;

const ENTRY_MIN_SCORE = 68;
const ENTRY_MIN_EXPLORATION_SCORE = 58;
const EXIT_SIGNAL_DECAY_SCORE = 50;
const MAX_BROWSER_ARCHIVE = 500;

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

  appState.paperArchive = appState.paperArchive.slice(0, MAX_BROWSER_ARCHIVE);

  persistState();

  return {
    ok: true,
    source: "browser-paper-engine-v4",
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
        barsHeld: Number(trade.barsHeld || 0) + 1,
        lastUpdatedAt: new Date().toISOString()
      });
      continue;
    }

    const price = Number(scan.current);
    const management = manageOpenTrade(trade, price, scan);

    if (management.close) {
      const closedTrade = buildClosedTrade(
        trade,
        management.exitPrice,
        management.reason,
        scan,
        management.pnlR
      );

      closed.push(closedTrade);
      appState.paperArchive.unshift(closedTrade);

      await saveClosedPaperTrade(closedTrade);
    } else {
      stillOpen.push({
        ...trade,
        ...management.updates,
        currentPrice: price,
        livePnlR: management.livePnlR,
        exitPressureScore: management.exitPressureScore,
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
    .map((scan) => enrichCandidate(scan))
    .filter((scan) => scan.tradeAllowed)
    .filter((scan) => scan.direction === "buy" || scan.direction === "sell")
    .filter((scan) => Number(scan.ultraScore || 0) >= minUltraScore)
    .filter((scan) => Number(scan.entryQualityScore || 0) >= ENTRY_MIN_SCORE)
    .filter((scan) => Number(scan.exitPressureScore || 0) < 62)
    .filter((scan) => !scan.tooLate)
    .filter((scan) => !openPairs.has(scan.pair))
    .filter((scan) => !wouldOverloadRiskGroup(scan.pair, currentRiskGroups))
    .sort((a, b) => scorePaperCandidate(b) - scorePaperCandidate(a));

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
      .map((scan) => enrichCandidate(scan))
      .filter((scan) => !openPairs.has(scan.pair))
      .filter((scan) => scan.direction === "buy" || scan.direction === "sell")
      .filter((scan) => Number(scan.ultraScore || 0) >= Number(engine.explorationScore || 58))
      .filter((scan) => Number(scan.entryQualityScore || 0) >= ENTRY_MIN_EXPLORATION_SCORE)
      .filter((scan) => Number(scan.archiveEdgeScore || 50) >= 48)
      .filter((scan) => Number(scan.exitPressureScore || 0) < 68)
      .filter((scan) => !scan.tooLate)
      .filter((scan) => !wouldOverloadRiskGroup(scan.pair, currentRiskGroups))
      .sort((a, b) => scorePaperCandidate(b) - scorePaperCandidate(a))[0];

    if (exploration) {
      opened.push(createBrowserPaperTrade(exploration, true));
    }
  }

  appState.paperTrades.unshift(...opened);

  return opened;
}

function enrichCandidate(scan) {
  const safe = scan || {};

  const entry = computeEntryQualityScore(safe);
  const exit = computeExitPressureScore(safe, null, 0);
  const tooLate = isLateEntry(safe);

  return {
    ...safe,
    entryQualityScore: entry.score,
    entryQualityLabel: entry.label,
    entryQualityReasons: entry.reasons,
    exitPressureScore: exit.score,
    exitPressureLabel: exit.label,
    tooLate
  };
}

function createBrowserPaperTrade(scan, exploration = false) {
  const now = new Date();
  const pair = String(scan.pair || "").toUpperCase();
  const entry = Number(scan.current || 0);
  const stopLoss = Number(scan.stopLoss || 0);
  const takeProfit = Number(scan.takeProfit || 0);
  const initialRiskDistance = Math.abs(entry - stopLoss);

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
    source: exploration ? "browser-paper-exploration-v4" : "browser-paper-v4",
    openedAt: now.toISOString(),
    lastUpdatedAt: now.toISOString(),

    entry,
    stopLoss,
    activeStopLoss: stopLoss,
    initialStopLoss: stopLoss,
    takeProfit,
    currentPrice: entry,
    initialRiskDistance,

    riskPercent,
    rr: Number(scan.rr || 0),
    barsHeld: 0,
    maxBarsHold: getMaxBarsHold(scan, exploration),

    partialTaken: false,
    partialRatio: 0,
    realizedPartialR: 0,
    breakEvenActivated: false,
    trailingActivated: false,

    entryQualityScore: Number(scan.entryQualityScore || 0),
    entryQualityLabel: scan.entryQualityLabel || "",
    exitPressureScore: Number(scan.exitPressureScore || 0),

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
      ? `BROWSER_EXPLORATION_V4_${pair}_EQ${Math.round(scan.entryQualityScore || 0)}`
      : `BROWSER_V4_${pair}_EQ${Math.round(scan.entryQualityScore || 0)}`
  };
}

function manageOpenTrade(trade, price, scan) {
  const direction = String(trade.direction || "buy").toLowerCase();
  const entry = Number(trade.entry || 0);
  const target = Number(trade.takeProfit || trade.take_profit || 0);
  const activeStop = Number(trade.activeStopLoss || trade.stopLoss || trade.stop_loss || 0);
  const originalRisk = getOriginalRiskDistance(trade);

  const livePnlR = computeLivePnlR(trade, price);
  const exitPressure = computeExitPressureScore(scan, trade, livePnlR);
  const barsHeld = Number(trade.barsHeld || trade.bars_held || 0);
  const maxBars = Number(trade.maxBarsHold || trade.max_bars_hold || 12);

  if (direction === "buy") {
    if (price <= activeStop) {
      return {
        close: true,
        reason: "active-stop",
        exitPrice: activeStop,
        pnlR: computePnlRWithPartial(trade, activeStop)
      };
    }

    if (price >= target) {
      return {
        close: true,
        reason: "take-profit",
        exitPrice: target,
        pnlR: computePnlRWithPartial(trade, target)
      };
    }
  }

  if (direction === "sell") {
    if (price >= activeStop) {
      return {
        close: true,
        reason: "active-stop",
        exitPrice: activeStop,
        pnlR: computePnlRWithPartial(trade, activeStop)
      };
    }

    if (price <= target) {
      return {
        close: true,
        reason: "take-profit",
        exitPrice: target,
        pnlR: computePnlRWithPartial(trade, target)
      };
    }
  }

  if (barsHeld >= maxBars) {
    return {
      close: true,
      reason: "time-exit",
      exitPrice: price,
      pnlR: computePnlRWithPartial(trade, price)
    };
  }

  if (Number(scan.ultraScore || 0) < EXIT_SIGNAL_DECAY_SCORE && livePnlR < 0.35) {
    return {
      close: true,
      reason: "signal-decay",
      exitPrice: price,
      pnlR: computePnlRWithPartial(trade, price)
    };
  }

  const scanSignal = String(scan.signal || "").toUpperCase();
  const tradeSignal = direction === "sell" ? "SELL" : "BUY";

  if (
    livePnlR < 0.75 &&
    (
      (tradeSignal === "BUY" && scanSignal === "SELL") ||
      (tradeSignal === "SELL" && scanSignal === "BUY")
    )
  ) {
    return {
      close: true,
      reason: "opposite-signal",
      exitPrice: price,
      pnlR: computePnlRWithPartial(trade, price)
    };
  }

  if (exitPressure.score >= 84) {
    return {
      close: true,
      reason: "exit-pressure",
      exitPrice: price,
      pnlR: computePnlRWithPartial(trade, price)
    };
  }

  const updates = {};
  let nextStop = activeStop;

  if (!trade.partialTaken && livePnlR >= 1) {
    updates.partialTaken = true;
    updates.partialRatio = 0.5;
    updates.realizedPartialR = 0.5;
  }

  if (livePnlR >= 0.85 && originalRisk > 0) {
    const breakEvenStop =
      direction === "buy"
        ? entry + originalRisk * 0.03
        : entry - originalRisk * 0.03;

    nextStop = improveStop(direction, nextStop, breakEvenStop);
    updates.breakEvenActivated = true;
  }

  if (livePnlR >= 1.25 && originalRisk > 0) {
    const lockedR =
      livePnlR >= 2.4 ? 1.55 :
      livePnlR >= 1.8 ? 1.05 :
      0.55;

    const trailStop =
      direction === "buy"
        ? entry + originalRisk * lockedR
        : entry - originalRisk * lockedR;

    nextStop = improveStop(direction, nextStop, trailStop);
    updates.trailingActivated = true;
  }

  updates.activeStopLoss = roundByPair(nextStop, trade.pair);
  updates.stopLoss = roundByPair(nextStop, trade.pair);

  return {
    close: false,
    livePnlR,
    exitPressureScore: exitPressure.score,
    updates
  };
}

function computeEntryQualityScore(scan) {
  const pair = String(scan.pair || "").toUpperCase();
  const direction = String(scan.direction || "").toLowerCase();
  const signal = String(scan.signal || "").toUpperCase();
  const candles = Array.isArray(scan.candles) ? scan.candles : [];

  const reasons = [];

  if (direction !== "buy" && direction !== "sell") {
    return {
      score: 0,
      label: "no-direction",
      reasons: ["No direction"]
    };
  }

  let score = 50;

  score += (Number(scan.ultraScore || 0) - 70) * 0.24;
  score += (Number(scan.trendScore || 50) - 50) * 0.18;
  score += (Number(scan.timingScore || 50) - 50) * 0.16;
  score += (Number(scan.executionScore || 50) - 50) * 0.18;
  score += (Number(scan.archiveEdgeScore || 50) - 50) * 0.12;
  score += (Number(scan.riskScore || 50) - 50) * 0.08;

  if (Number(scan.mtfScore || 0) >= 82) {
    score += 8;
    reasons.push("Strong MTF");
  } else if (Number(scan.mtfScore || 0) >= 68) {
    score += 4;
    reasons.push("MTF confirmed");
  } else if (Number(scan.mtfScore || 0) > 0) {
    score -= 8;
    reasons.push("Weak MTF");
  }

  if (candles.length >= 20) {
    const trigger = computeCandleTriggerScore(candles, direction);
    score += trigger.score;
    reasons.push(...trigger.reasons);

    const late = computeLateEntryPenalty(candles, direction, pair);
    score -= late.penalty;
    reasons.push(...late.reasons);
  }

  if (signal === "BUY" || signal === "SELL") {
    score += 4;
  }

  if (Number(scan.rsi14 || 50) > 74 && direction === "buy") {
    score -= pair === "BTCUSD" ? 10 : 7;
    reasons.push("RSI buy extended");
  }

  if (Number(scan.rsi14 || 50) < 26 && direction === "sell") {
    score -= pair === "BTCUSD" ? 10 : 7;
    reasons.push("RSI sell extended");
  }

  if (pair === "BTCUSD") {
    score -= 3;

    if (Number(scan.riskScore || 50) >= 52 && Number(scan.entryQualityScore || 0) !== 0) {
      score += 2;
    }
  }

  if (pair === "XAUUSD") {
    score -= 1;
  }

  const finalScore = clamp(score, 1, 99);

  return {
    score: Math.round(finalScore),
    label:
      finalScore >= 82 ? "sniper-entry" :
      finalScore >= 72 ? "clean-entry" :
      finalScore >= 64 ? "acceptable-entry" :
      "weak-entry",
    reasons
  };
}

function computeCandleTriggerScore(candles, direction) {
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const recent = candles.slice(-14);

  const avgRange = average(recent.map((c) => Number(c.high || 0) - Number(c.low || 0)));
  const range = Math.max(0.0000001, Number(last.high || 0) - Number(last.low || 0));
  const body = Math.abs(Number(last.close || 0) - Number(last.open || 0));
  const bodyRatio = body / range;

  let score = 0;
  const reasons = [];

  if (direction === "buy") {
    if (last.close > last.open) {
      score += 5;
      reasons.push("Bull candle");
    }

    if (last.close > prev.high) {
      score += 8;
      reasons.push("Buy breakout");
    }

    if (last.close > last.low + range * 0.68) {
      score += 5;
      reasons.push("Close near high");
    }

    if (last.low >= prev.low) {
      score += 3;
      reasons.push("Higher low");
    }
  }

  if (direction === "sell") {
    if (last.close < last.open) {
      score += 5;
      reasons.push("Bear candle");
    }

    if (last.close < prev.low) {
      score += 8;
      reasons.push("Sell breakdown");
    }

    if (last.close < last.high - range * 0.68) {
      score += 5;
      reasons.push("Close near low");
    }

    if (last.high <= prev.high) {
      score += 3;
      reasons.push("Lower high");
    }
  }

  if (bodyRatio >= 0.52 && bodyRatio <= 0.82) {
    score += 5;
    reasons.push("Healthy impulse");
  }

  if (avgRange > 0 && range > avgRange * 2.4) {
    score -= 12;
    reasons.push("Impulse too large");
  }

  return {
    score,
    reasons
  };
}

function computeLateEntryPenalty(candles, direction, pair) {
  const closes = candles.map((c) => Number(c.close || 0)).filter(Number.isFinite);
  const highs = candles.map((c) => Number(c.high || 0)).filter(Number.isFinite);
  const lows = candles.map((c) => Number(c.low || 0)).filter(Number.isFinite);

  const current = closes.at(-1);
  const ema20Value = ema(closes, 20);
  const atrValue = atr(highs, lows, closes, 14);

  if (!current || !ema20Value || !atrValue) {
    return {
      penalty: 0,
      reasons: []
    };
  }

  const distance = Math.abs(current - ema20Value);
  const maxDistance =
    pair === "BTCUSD" ? atrValue * 2.8 :
    pair === "XAUUSD" ? atrValue * 2.4 :
    atrValue * 2.1;

  const reasons = [];

  if (distance > maxDistance) {
    reasons.push("Late entry distance");
    return {
      penalty: 14,
      reasons
    };
  }

  if (distance > maxDistance * 0.75) {
    reasons.push("Entry slightly extended");
    return {
      penalty: 6,
      reasons
    };
  }

  return {
    penalty: 0,
    reasons
  };
}

function computeExitPressureScore(scan, trade = null, livePnlR = 0) {
  let score = 28;

  score += weakness(Number(scan.trendScore || 50), 50) * 0.22;
  score += weakness(Number(scan.timingScore || 50), 48) * 0.18;
  score += weakness(Number(scan.executionScore || 50), 48) * 0.18;
  score += weakness(Number(scan.smartMoneyScore || 50), 48) * 0.12;
  score += weakness(Number(scan.riskScore || 50), 44) * 0.12;
  score += weakness(Number(scan.archiveEdgeScore || 50), 45) * 0.08;

  if (String(scan.signal || "").toUpperCase() === "WAIT") {
    score += 8;
  }

  if (trade) {
    const direction = String(trade.direction || "").toLowerCase();
    const tradeSignal = direction === "sell" ? "SELL" : "BUY";
    const scanSignal = String(scan.signal || "").toUpperCase();

    if (
      (tradeSignal === "BUY" && scanSignal === "SELL") ||
      (tradeSignal === "SELL" && scanSignal === "BUY")
    ) {
      score += livePnlR < 0.75 ? 18 : 10;
    }

    const mtfSignal = String(scan.mtfSignal || "").toUpperCase();

    if (
      mtfSignal &&
      mtfSignal !== "WAIT" &&
      mtfSignal !== tradeSignal
    ) {
      score += 14;
    }
  }

  if (String(scan.pair || "").toUpperCase() === "BTCUSD") {
    if (Number(scan.volatility || 0) > 0.035) score += 12;
    if (Math.abs(Number(scan.momentum || 0)) > 7) score += 8;
  }

  if (livePnlR >= 1.2 && Number(scan.ultraScore || 0) >= 76) {
    score -= 8;
  }

  if (livePnlR >= 2 && Number(scan.executionScore || 0) >= 62) {
    score -= 6;
  }

  const finalScore = clamp(score, 1, 99);

  return {
    score: Math.round(finalScore),
    label:
      finalScore >= 84 ? "close-pressure" :
      finalScore >= 68 ? "reduce-pressure" :
      finalScore >= 54 ? "trail-pressure" :
      "hold"
  };
}

function isLateEntry(scan) {
  const pair = String(scan.pair || "").toUpperCase();
  const candles = Array.isArray(scan.candles) ? scan.candles : [];

  if (candles.length < 30) return false;

  const closes = candles.map((c) => Number(c.close || 0)).filter(Number.isFinite);
  const highs = candles.map((c) => Number(c.high || 0)).filter(Number.isFinite);
  const lows = candles.map((c) => Number(c.low || 0)).filter(Number.isFinite);

  const current = Number(scan.current || closes.at(-1) || 0);
  const ema20Value = ema(closes, 20);
  const atrValue = Number(scan.atr14 || atr(highs, lows, closes, 14));

  if (!current || !ema20Value || !atrValue) return false;

  const distance = Math.abs(current - ema20Value);

  const max =
    pair === "BTCUSD" ? atrValue * 3.2 :
    pair === "XAUUSD" ? atrValue * 2.7 :
    atrValue * 2.4;

  return distance > max;
}

function getMaxBarsHold(scan, exploration) {
  const timeframe = String(scan.timeframe || appState.timeframe || "M15").toUpperCase();
  const pair = String(scan.pair || "").toUpperCase();

  let base =
    timeframe === "M5" ? 18 :
    timeframe === "M15" ? 14 :
    timeframe === "H1" ? 10 :
    timeframe === "H4" ? 8 :
    12;

  if (pair === "BTCUSD") base += 2;
  if (exploration) base = Math.max(5, base - 4);

  return base;
}

function computePnlRWithPartial(trade, exitPrice) {
  const entry = Number(trade.entry || 0);
  const direction = String(trade.direction || "buy").toLowerCase();
  const originalRisk = getOriginalRiskDistance(trade);

  if (!entry || !originalRisk) return 0;

  const liveR =
    direction === "buy"
      ? (Number(exitPrice) - entry) / originalRisk
      : (entry - Number(exitPrice)) / originalRisk;

  const partialRatio = Number(trade.partialRatio || 0);
  const realizedPartialR = Number(trade.realizedPartialR || 0);
  const openRatio = Math.max(0, 1 - partialRatio);

  return round(realizedPartialR + liveR * openRatio, 3);
}

function buildClosedTrade(trade, exitPrice, closeReason, scan, forcedPnlR = null) {
  const entry = Number(trade.entry || 0);
  const stop = Number(trade.initialStopLoss || trade.stopLoss || trade.stop_loss || 0);
  const direction = String(trade.direction || "buy").toLowerCase();

  const pnlR = Number.isFinite(Number(forcedPnlR))
    ? Number(forcedPnlR)
    : computePnlRWithPartial(trade, exitPrice);

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
    source: trade.source || "browser-paper-v4",
    modelTag: trade.modelTag || "BROWSER_V4",

    partialTaken: Boolean(trade.partialTaken),
    entryQualityScore: Number(trade.entryQualityScore || 0),
    exitPressureScore: Number(trade.exitPressureScore || 0)
  };
}

function scorePaperCandidate(scan) {
  return (
    Number(scan.ultraScore || 0) * 0.30 +
    Number(scan.entryQualityScore || 0) * 0.25 +
    Number(scan.archiveEdgeScore || 50) * 0.15 +
    Number(scan.mtfScore || 60) * 0.14 +
    Number(scan.executionScore || 50) * 0.08 +
    Number(scan.riskScore || 50) * 0.05 +
    (100 - Number(scan.exitPressureScore || 50)) * 0.03
  );
}

function computeBrowserRiskPercent(scan) {
  const pair = String(scan.pair || "").toUpperCase();
  const ultra = Number(scan.ultraScore || 0);
  const risk = Number(scan.riskScore || 50);
  const archive = Number(scan.archiveEdgeScore || 50);
  const mtf = Number(scan.mtfScore || 0);
  const entry = Number(scan.entryQualityScore || 0);

  let riskPercent = Number(appState.paperEngine?.riskPerTrade || 0.25);

  if (ultra >= 82 && risk >= 52 && entry >= 74) riskPercent *= 1.2;
  if (ultra >= 88 && risk >= 58 && archive >= 58 && entry >= 82) riskPercent *= 1.45;
  if (ultra < 72) riskPercent *= 0.65;
  if (entry < 68) riskPercent *= 0.55;
  if (risk < 45) riskPercent *= 0.5;
  if (archive < 45) riskPercent *= 0.7;

  if (mtf > 0 && mtf < 60) riskPercent *= 0.5;
  if (mtf >= 82) riskPercent *= 1.08;

  if (pair === "XAUUSD") riskPercent *= 0.82;
  if (pair === "BTCUSD") riskPercent *= 0.6;
  if (pair.startsWith("GBP")) riskPercent *= 0.9;

  return Number(Math.max(0.03, Math.min(0.75, riskPercent)).toFixed(2));
}

function computeLivePnlR(trade, price) {
  const entry = Number(trade.entry || 0);
  const direction = String(trade.direction || "buy").toLowerCase();
  const originalRisk = getOriginalRiskDistance(trade);

  if (!entry || !originalRisk) return 0;

  const pnlR =
    direction === "buy"
      ? (Number(price) - entry) / originalRisk
      : (entry - Number(price)) / originalRisk;

  return round(pnlR, 3);
}

function getOriginalRiskDistance(trade) {
  const entry = Number(trade.entry || 0);
  const initialStop = Number(trade.initialStopLoss || trade.initial_stop_loss || 0);
  const currentStop = Number(trade.stopLoss || trade.stop_loss || 0);
  const stored = Number(trade.initialRiskDistance || trade.initial_risk_distance || 0);

  if (stored > 0) return stored;
  if (entry && initialStop) return Math.abs(entry - initialStop);
  if (entry && currentStop) return Math.abs(entry - currentStop);

  return 0;
}

function improveStop(direction, currentStop, candidateStop) {
  if (!currentStop) return candidateStop;

  if (direction === "buy") {
    return Math.max(currentStop, candidateStop);
  }

  return Math.min(currentStop, candidateStop);
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

function weakness(score, level) {
  const n = Number(score || 50);

  if (n >= level + 18) return 0;
  if (n >= level + 10) return 10;
  if (n >= level) return 25;
  if (n >= level - 10) return 45;

  return 65;
}

function ema(values, period) {
  const nums = values.map(Number).filter(Number.isFinite);

  if (!nums.length) return 0;

  const k = 2 / (period + 1);
  let prev = nums[0];

  for (let i = 1; i < nums.length; i += 1) {
    prev = nums[i] * k + prev * (1 - k);
  }

  return prev;
}

function atr(highs, lows, closes, period = 14) {
  if (highs.length < 2) return 0;

  const trs = [];

  for (let i = 1; i < highs.length; i += 1) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }

  const recent = trs.slice(-period);

  if (!recent.length) return 0;

  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);

  if (!nums.length) return 0;

  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
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

function clamp(value, min = 1, max = 99) {
  const n = Number(value);

  if (!Number.isFinite(n)) return min;

  return Math.max(min, Math.min(max, n));
}
