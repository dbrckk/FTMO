const EXECUTION_VERSION = "realistic-execution-v1";

const DEFAULT_PROFILES = {
  DEFAULT: {
    spreadPips: 1.2,
    entrySlippagePips: 0.25,
    exitSlippagePips: 0.35,
    commissionR: 0.015
  },

  EURUSD: {
    spreadPips: 0.9,
    entrySlippagePips: 0.15,
    exitSlippagePips: 0.2,
    commissionR: 0.012
  },

  GBPUSD: {
    spreadPips: 1.2,
    entrySlippagePips: 0.2,
    exitSlippagePips: 0.25,
    commissionR: 0.014
  },

  USDJPY: {
    spreadPips: 1.1,
    entrySlippagePips: 0.18,
    exitSlippagePips: 0.25,
    commissionR: 0.013
  },

  EURJPY: {
    spreadPips: 1.4,
    entrySlippagePips: 0.22,
    exitSlippagePips: 0.3,
    commissionR: 0.014
  },

  GBPJPY: {
    spreadPips: 1.9,
    entrySlippagePips: 0.35,
    exitSlippagePips: 0.45,
    commissionR: 0.018
  },

  XAUUSD: {
    spreadPips: 2.8,
    entrySlippagePips: 0.75,
    exitSlippagePips: 0.95,
    commissionR: 0.025
  },

  BTCUSD: {
    spreadPips: 18,
    entrySlippagePips: 7,
    exitSlippagePips: 9,
    commissionR: 0.04
  }
};

export function buildRealisticEntry(scan, options = {}) {
  const pair = normalizePair(scan?.pair);
  const direction = String(scan?.direction || "").toLowerCase();
  const current = Number(scan?.current || 0);
  const rr = Number(scan?.rr || getDefaultRr(pair));

  if (!current || (direction !== "buy" && direction !== "sell")) {
    return {
      version: EXECUTION_VERSION,
      pair,
      direction,
      entry: current,
      stopLoss: Number(scan?.stopLoss || 0),
      takeProfit: Number(scan?.takeProfit || 0),
      tp1: Number(scan?.tp1 || 0),
      rr,
      executionCostR: 0,
      spreadCostR: 0,
      slippageCostR: 0,
      commissionR: 0,
      profile: getExecutionProfile(pair, options.env)
    };
  }

  const profile = getExecutionProfile(pair, options.env);
  const pipSize = getPipSize(pair);

  const spreadPrice = profile.spreadPips * pipSize;
  const entrySlippagePrice = profile.entrySlippagePips * pipSize;
  const adverseEntryPrice = spreadPrice * 0.5 + entrySlippagePrice;

  const rawStop = Number(scan?.stopLoss || 0);
  const rawTakeProfit = Number(scan?.takeProfit || 0);

  const rawRiskDistance =
    rawStop > 0
      ? Math.abs(current - rawStop)
      : getFallbackRiskDistance(pair, current);

  const entry =
    direction === "buy"
      ? current + adverseEntryPrice
      : current - adverseEntryPrice;

  const stopLoss =
    direction === "buy"
      ? entry - rawRiskDistance
      : entry + rawRiskDistance;

  const takeProfit =
    direction === "buy"
      ? entry + rawRiskDistance * rr
      : entry - rawRiskDistance * rr;

  const tp1 =
    direction === "buy"
      ? entry + rawRiskDistance * 1.05
      : entry - rawRiskDistance * 1.05;

  const spreadCostR = rawRiskDistance > 0 ? (spreadPrice * 0.5) / rawRiskDistance : 0;
  const slippageCostR = rawRiskDistance > 0 ? entrySlippagePrice / rawRiskDistance : 0;
  const executionCostR = spreadCostR + slippageCostR + Number(profile.commissionR || 0);

  return {
    version: EXECUTION_VERSION,
    pair,
    direction,

    rawEntry: roundByPair(current, pair),
    entry: roundByPair(entry, pair),
    rawStopLoss: roundByPair(rawStop, pair),
    stopLoss: roundByPair(stopLoss, pair),
    rawTakeProfit: roundByPair(rawTakeProfit, pair),
    takeProfit: roundByPair(takeProfit, pair),
    tp1: roundByPair(tp1, pair),
    rr,

    riskDistance: rawRiskDistance,

    spreadPips: profile.spreadPips,
    entrySlippagePips: profile.entrySlippagePips,
    exitSlippagePips: profile.exitSlippagePips,

    spreadPrice,
    entrySlippagePrice,

    spreadCostR: round(spreadCostR, 4),
    slippageCostR: round(slippageCostR, 4),
    commissionR: round(Number(profile.commissionR || 0), 4),
    executionCostR: round(executionCostR, 4),

    profile
  };
}

export function buildRealisticExit(trade, rawExitPrice, options = {}) {
  const pair = normalizePair(trade?.pair);
  const direction = String(trade?.direction || "").toLowerCase();
  const exit = Number(rawExitPrice || 0);

  if (!exit || (direction !== "buy" && direction !== "sell")) {
    return {
      version: EXECUTION_VERSION,
      pair,
      direction,
      rawExitPrice: exit,
      exitPrice: exit,
      grossPnlR: 0,
      netPnlR: 0,
      executionCostR: 0,
      profile: getExecutionProfile(pair, options.env)
    };
  }

  const profile = getExecutionProfile(pair, options.env);
  const pipSize = getPipSize(pair);

  const spreadPrice = profile.spreadPips * pipSize;
  const exitSlippagePrice = profile.exitSlippagePips * pipSize;
  const adverseExitPrice = spreadPrice * 0.5 + exitSlippagePrice;

  const realisticExit =
    direction === "buy"
      ? exit - adverseExitPrice
      : exit + adverseExitPrice;

  const grossPnlR = computePnlR(trade, exit);
  const pnlRBeforeCommission = computePnlR(trade, realisticExit);
  const netPnlR = pnlRBeforeCommission - Number(profile.commissionR || 0);

  const executionCostR = grossPnlR - netPnlR;

  return {
    version: EXECUTION_VERSION,
    pair,
    direction,

    rawExitPrice: roundByPair(exit, pair),
    exitPrice: roundByPair(realisticExit, pair),

    spreadPips: profile.spreadPips,
    exitSlippagePips: profile.exitSlippagePips,

    spreadPrice,
    exitSlippagePrice,

    grossPnlR: round(grossPnlR, 4),
    netPnlR: round(netPnlR, 4),

    spreadCostR: round(spreadPrice * 0.5 / Math.max(getOriginalRiskDistance(trade), 0.0000001), 4),
    slippageCostR: round(exitSlippagePrice / Math.max(getOriginalRiskDistance(trade), 0.0000001), 4),
    commissionR: round(Number(profile.commissionR || 0), 4),
    executionCostR: round(executionCostR, 4),

    profile
  };
}

export function getExecutionProfile(pair, env = {}) {
  const normalized = normalizePair(pair);

  let overrides = {};

  const raw =
    env.EXECUTION_PROFILES_JSON ||
    env.PAPER_EXECUTION_PROFILES_JSON ||
    "";

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      overrides = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      overrides = {};
    }
  }

  const base =
    DEFAULT_PROFILES[normalized] ||
    DEFAULT_PROFILES.DEFAULT;

  const override =
    overrides[normalized] ||
    overrides.DEFAULT ||
    {};

  return {
    ...base,
    ...override
  };
}

export function estimateExecutionPenaltyR(pair, riskDistance, env = {}) {
  const normalized = normalizePair(pair);
  const profile = getExecutionProfile(normalized, env);
  const pipSize = getPipSize(normalized);

  const spreadPrice = profile.spreadPips * pipSize;
  const slippagePrice = (profile.entrySlippagePips + profile.exitSlippagePips) * pipSize;

  const priceCostR =
    Number(riskDistance || 0) > 0
      ? (spreadPrice + slippagePrice) / Number(riskDistance)
      : 0;

  return round(priceCostR + Number(profile.commissionR || 0), 4);
}

function computePnlR(trade, exitPrice) {
  const entry = Number(trade?.entry || 0);
  const direction = String(trade?.direction || "buy").toLowerCase();
  const risk = getOriginalRiskDistance(trade);

  if (!entry || !risk || !exitPrice) return 0;

  return direction === "buy"
    ? (Number(exitPrice) - entry) / risk
    : (entry - Number(exitPrice)) / risk;
}

function getOriginalRiskDistance(trade) {
  const entry = Number(trade?.entry || 0);
  const stop = Number(trade?.stopLoss || trade?.stop_loss || 0);
  const target = Number(trade?.takeProfit || trade?.take_profit || 0);
  const rr = Number(trade?.rr || getDefaultRr(trade?.pair));

  if (entry && target && rr > 0) return Math.abs(target - entry) / rr;
  if (entry && stop) return Math.abs(entry - stop);

  return 0;
}

function getFallbackRiskDistance(pair, current) {
  const p = normalizePair(pair);
  const price = Number(current || 0);

  if (!price) return 0;

  if (p === "BTCUSD") return price * 0.006;
  if (p === "XAUUSD") return price * 0.003;
  if (p.includes("JPY")) return price * 0.0022;

  return price * 0.002;
}

function getPipSize(pair) {
  const p = normalizePair(pair);

  if (p === "BTCUSD") return 1;
  if (p === "XAUUSD") return 0.1;
  if (p.includes("JPY")) return 0.01;

  return 0.0001;
}

function getDefaultRr(pair) {
  const p = normalizePair(pair);

  if (p === "BTCUSD") return 1.45;
  if (p === "XAUUSD") return 1.5;

  return 1.35;
}

function normalizePair(pair) {
  return String(pair || "")
    .toUpperCase()
    .replaceAll(".", "")
    .replaceAll("_", "")
    .replaceAll("-", "")
    .trim();
}

function roundByPair(value, pair) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  const p = normalizePair(pair);

  if (p === "XAUUSD" || p === "BTCUSD") return Number(n.toFixed(2));
  if (p.includes("JPY")) return Number(n.toFixed(3));

  return Number(n.toFixed(5));
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Number(n.toFixed(digits));
                                    }
