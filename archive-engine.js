import { clamp } from "./utils.js";

export function getSessionLabelFromDate(date = new Date()) {
  const hour = Number(
    date.toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );

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

export function normalizeArchivedTrade(raw) {
  return {
    id: raw.id || Date.now(),
    pair: String(raw.pair || "").toUpperCase(),
    direction: String(raw.direction || "buy").toLowerCase(),
    openedAt: raw.openedAt || raw.createdAt || new Date().toISOString(),
    closedAt: raw.closedAt || new Date().toISOString(),
    pnlR: Number(raw.pnlR || 0),
    pnl: Number(raw.pnl || 0),
    win: raw.win === true || Number(raw.pnlR || 0) > 0,
    strategyTag: raw.strategyTag || "",
    session: raw.session || "",
    hour:
      Number.isFinite(Number(raw.hour))
        ? Number(raw.hour)
        : inferHour(raw.closedAt || raw.openedAt),
    notes: raw.notes || ""
  };
}

export function buildArchiveStats({
  pair,
  direction,
  archiveTrades = [],
  now = new Date()
}) {
  const safePair = String(pair || "").toUpperCase();
  const safeDirection = String(direction || "buy").toLowerCase();
  const currentHour = inferHour(now);
  const currentSession = getSessionLabelFromDate(now);

  const normalized = archiveTrades
    .map(normalizeArchivedTrade)
    .filter((t) => t.pair);

  const pairTrades = normalized.filter((t) => t.pair === safePair);
  const directionTrades = pairTrades.filter((t) => t.direction === safeDirection);
  const hourTrades = pairTrades.filter((t) => t.hour === currentHour);
  const sessionTrades = pairTrades.filter(
    (t) => (t.session || getSessionLabelFromDate(new Date(t.closedAt))) === currentSession
  );

  const last20PairTrades = [...pairTrades].slice(-20);
  const last20DirectionTrades = [...directionTrades].slice(-20);

  return {
    pair,
    direction: safeDirection,
    currentHour,
    currentSession,

    totalArchivedTrades: normalized.length,
    pairTradesCount: pairTrades.length,
    directionTradesCount: directionTrades.length,
    hourTradesCount: hourTrades.length,
    sessionTradesCount: sessionTrades.length,

    pairWinRate: computeWinRate(pairTrades),
    pairExpectancy: computeExpectancy(pairTrades),

    hourWinRate: computeWinRate(hourTrades),
    hourExpectancy: computeExpectancy(hourTrades),

    sessionWinRate: computeWinRate(sessionTrades),
    sessionExpectancy: computeExpectancy(sessionTrades),

    sameDirectionWinRate: computeWinRate(directionTrades),
    sameDirectionExpectancy: computeExpectancy(directionTrades),

    last20WinRate: computeWinRate(last20PairTrades),
    last20Expectancy: computeExpectancy(last20PairTrades),

    last20DirectionWinRate: computeWinRate(last20DirectionTrades),
    last20DirectionExpectancy: computeExpectancy(last20DirectionTrades),

    archiveConfidence: computeArchiveConfidence({
      pairTrades,
      directionTrades,
      hourTrades,
      sessionTrades
    })
  };
}

export function pushClosedTradeToArchive(appState, trade) {
  if (!appState.tradeArchive) appState.tradeArchive = [];

  const normalized = normalizeArchivedTrade(trade);
  appState.tradeArchive.push(normalized);

  if (appState.tradeArchive.length > 2000) {
    appState.tradeArchive = appState.tradeArchive.slice(-2000);
  }

  return normalized;
}

export function computeArchiveConfidence({
  pairTrades = [],
  directionTrades = [],
  hourTrades = [],
  sessionTrades = []
}) {
  const pairCount = pairTrades.length;
  const dirCount = directionTrades.length;
  const hourCount = hourTrades.length;
  const sessionCount = sessionTrades.length;

  const score =
    pairCount * 0.9 +
    dirCount * 1.0 +
    hourCount * 0.8 +
    sessionCount * 0.8;

  return clamp(Math.round(score), 1, 99);
}

export function computeWinRate(trades) {
  if (!trades.length) return 50;

  const wins = trades.filter((t) => t.win || Number(t.pnlR || 0) > 0).length;
  return (wins / trades.length) * 100;
}

export function computeExpectancy(trades) {
  if (!trades.length) return 0;

  const totalR = trades.reduce((sum, t) => sum + Number(t.pnlR || 0), 0);
  return totalR / trades.length;
}

function inferHour(dateLike) {
  const date = new Date(dateLike || new Date());
  return Number(
    date.toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );
  }
