export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    if (!body.ok) {
      return json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    const p = normalizePayload(body.data);

    const directionFactor = p.direction === "sell" ? -1 : 1;
    const move = (p.currentPrice - p.entry) * directionFactor;
    const riskDistance = Math.abs(p.entry - p.stopLoss) || 0.00001;
    const targetDistance = Math.abs(p.takeProfit - p.entry) || 0.00001;

    const rMultiple = move / riskDistance;
    const tpProgress = (move / targetDistance) * 100;

    let decision = "HOLD";
    let partialClosePercent = 0;
    let newStopLoss = p.stopLoss;
    let reason = "Le trade peut rester ouvert pour le moment.";

    if (p.macroDanger) {
      decision = "EXIT_NOW";
      partialClosePercent = 100;
      newStopLoss = p.currentPrice;
      reason = "Contexte macro dangereux : sortie immédiate privilégiée.";
    } else if (rMultiple >= 1.5 && Math.abs(p.momentum) < 0.08) {
      decision = "PARTIAL_EXIT";
      partialClosePercent = 50;
      newStopLoss = p.entry;
      reason = "Le trade a bien avancé mais le momentum ralentit.";
    } else if (rMultiple >= 1.8) {
      decision = "TRAIL_STOP";
      partialClosePercent = 0;
      newStopLoss =
        p.direction === "buy"
          ? p.currentPrice - p.atr14 * 1.1
          : p.currentPrice + p.atr14 * 1.1;
      reason = "Le trade est assez mature pour un trailing stop agressif.";
    } else if (rMultiple >= 1.0) {
      decision = "MOVE_TO_BREAKEVEN";
      partialClosePercent = 0;
      newStopLoss = p.entry;
      reason = "Le trade a atteint 1R, passage au break-even.";
    } else if (p.confidence < 55) {
      decision = "LIGHTEN";
      partialClosePercent = 25;
      newStopLoss = p.stopLoss;
      reason = "Le maintien du trade devient moins propre.";
    }

    return json({
      ok: true,
      decision,
      rMultiple: Number.isFinite(rMultiple) ? rMultiple.toFixed(2) : "0.00",
      tpProgress: Number.isFinite(tpProgress) ? tpProgress.toFixed(2) : "0.00",
      partialClosePercent,
      newStopLoss: formatPrice(newStopLoss),
      reason
    });
  } catch {
    return json({
      ok: false,
      error: "Exit engine failed"
    }, 500);
  }
}

function normalizePayload(data) {
  return {
    pair: cleanText(data.pair, "EURUSD"),
    direction: String(data.direction || "buy").toLowerCase() === "sell" ? "sell" : "buy",
    entry: Number(data.entry) || 0,
    currentPrice: Number(data.currentPrice) || 0,
    stopLoss: Number(data.stopLoss) || 0,
    takeProfit: Number(data.takeProfit) || 0,
    atr14: Math.max(Number(data.atr14) || 0, 0),
    macroDanger: Boolean(data.macroDanger),
    momentum: Number(data.momentum) || 0,
    confidence: clampNumber(data.confidence, 1, 99, 70)
  };
}

async function safeJson(request) {
  try {
    return { ok: true, data: await request.json() };
  } catch {
    return { ok: false };
  }
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return n.toFixed(n > 100 ? 2 : 5);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanText(value, fallback) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 40) : fallback;
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
