export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const data = body?.data || body || {};

    const result = computeExitDecision(data);

    return json({
      ok: true,
      source: "local-exit-engine",
      ...result
    });
  } catch (error) {
    return json({
      ok: true,
      source: "exit-safe-fallback",
      decision: "HOLD",
      rMultiple: 0,
      tpProgress: 0,
      partialClosePercent: 0,
      newStopLoss: null,
      reason: String(error?.message || "Fallback exit engine.")
    });
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    message: "POST trade data to compute exit suggestion."
  });
}

function computeExitDecision(data) {
  const pair = String(data.pair || "").toUpperCase();
  const direction = String(data.direction || "buy").toLowerCase();

  const entry = num(data.entry, 0);
  const currentPrice = num(data.currentPrice, entry);
  const stopLoss = num(data.stopLoss, 0);
  const takeProfit = num(data.takeProfit, 0);
  const atr14 = num(data.atr14, 0);
  const momentum = num(data.momentum, 0);
  const confidence = num(data.confidence, 50);
  const macroDanger = Boolean(data.macroDanger);

  if (!entry || !currentPrice || !stopLoss || !takeProfit) {
    return {
      decision: "HOLD",
      rMultiple: 0,
      tpProgress: 0,
      partialClosePercent: 0,
      newStopLoss: null,
      reason: "Données insuffisantes pour calculer la sortie."
    };
  }

  const riskDistance = Math.abs(entry - stopLoss);
  const targetDistance = Math.abs(takeProfit - entry);

  if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
    return {
      decision: "HOLD",
      rMultiple: 0,
      tpProgress: 0,
      partialClosePercent: 0,
      newStopLoss: null,
      reason: "Distance au stop invalide."
    };
  }

  const profitDistance =
    direction === "sell"
      ? entry - currentPrice
      : currentPrice - entry;

  const rMultiple = profitDistance / riskDistance;
  const tpProgress = targetDistance > 0
    ? clamp((profitDistance / targetDistance) * 100, -100, 150)
    : 0;

  const atrTrail =
    atr14 > 0
      ? atr14 * (pair === "XAUUSD" ? 1.25 : 1.1)
      : riskDistance * 0.55;

  let decision = "HOLD";
  let partialClosePercent = 0;
  let newStopLoss = null;
  let reason = "Aucune sortie nécessaire.";

  if (macroDanger && rMultiple > 0.2) {
    decision = "REDUCE";
    partialClosePercent = 50;
    newStopLoss = direction === "sell"
      ? Math.min(stopLoss, entry)
      : Math.max(stopLoss, entry);
    reason = "Danger macro détecté, réduction du risque.";
  } else if (rMultiple >= 2.0) {
    decision = "PARTIAL CLOSE";
    partialClosePercent = 60;
    newStopLoss = computeTrailingStop(direction, currentPrice, atrTrail, entry);
    reason = "Objectif avancé atteint, sécurisation agressive.";
  } else if (rMultiple >= 1.2) {
    decision = "PARTIAL CLOSE";
    partialClosePercent = 35;
    newStopLoss = computeBreakEvenPlus(direction, entry, riskDistance);
    reason = "Trade en gain, sécurisation partielle.";
  } else if (rMultiple >= 0.75 && confidence < 58) {
    decision = "REDUCE";
    partialClosePercent = 25;
    newStopLoss = computeBreakEvenPlus(direction, entry, riskDistance * 0.35);
    reason = "Gain correct mais confiance moyenne.";
  } else if (rMultiple <= -0.75) {
    decision = "HOLD / RESPECT STOP";
    partialClosePercent = 0;
    newStopLoss = stopLoss;
    reason = "Trade proche du stop, ne pas élargir le risque.";
  } else if (momentum < -0.15 && direction === "buy" && rMultiple > 0.3) {
    decision = "REDUCE";
    partialClosePercent = 25;
    newStopLoss = Math.max(stopLoss, entry);
    reason = "Momentum défavorable au buy, réduction prudente.";
  } else if (momentum > 0.15 && direction === "sell" && rMultiple > 0.3) {
    decision = "REDUCE";
    partialClosePercent = 25;
    newStopLoss = Math.min(stopLoss, entry);
    reason = "Momentum défavorable au sell, réduction prudente.";
  }

  return {
    decision,
    rMultiple: Number(rMultiple.toFixed(2)),
    tpProgress: Number(tpProgress.toFixed(1)),
    partialClosePercent,
    newStopLoss: newStopLoss == null ? null : roundByPair(newStopLoss, pair),
    reason
  };
}

function computeTrailingStop(direction, currentPrice, atrTrail, entry) {
  if (direction === "sell") {
    return Math.min(entry, currentPrice + atrTrail);
  }

  return Math.max(entry, currentPrice - atrTrail);
}

function computeBreakEvenPlus(direction, entry, distance) {
  if (direction === "sell") {
    return entry - Math.abs(distance) * 0.1;
  }

  return entry + Math.abs(distance) * 0.1;
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function roundByPair(value, pair) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (pair === "XAUUSD") return Number(n.toFixed(2));
  if (String(pair).includes("JPY")) return Number(n.toFixed(3));
  return Number(n.toFixed(5));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
    }
