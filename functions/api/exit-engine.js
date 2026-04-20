export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    const pair = cleanText(body.pair, "EURUSD");
    const direction = oneOf(String(body.direction || "buy").toLowerCase(), ["buy", "sell"], "buy");
    const entry = Number(body.entry);
    const currentPrice = Number(body.currentPrice);
    const stopLoss = Number(body.stopLoss);
    const takeProfit = Number(body.takeProfit);
    const atr14 = Math.max(Number(body.atr14) || 0, 0.00001);

    const macroDanger = Boolean(body.macroDanger);
    const momentum = Number(body.momentum || 0);
    const confidence = clamp(Number(body.confidence || 50), 1, 99);

    if (![entry, currentPrice, stopLoss, takeProfit].every(Number.isFinite)) {
      return json({ ok: false, error: "Invalid payload" }, 400);
    }

    const riskDistance = Math.abs(entry - stopLoss) || 0.00001;
    const rewardDistance = Math.abs(takeProfit - entry) || 0.00001;

    const pnlDistance = direction === "buy"
      ? currentPrice - entry
      : entry - currentPrice;

    const rMultiple = pnlDistance / riskDistance;
    const tpProgress = pnlDistance / rewardDistance;

    let decision = "HOLD";
    let reason = "Le trade reste valide.";
    let newStopLoss = stopLoss;
    let partialClose = 0;

    if (macroDanger && rMultiple > 0.3) {
      decision = "CLOSE_NOW";
      reason = "Une fenêtre macro dangereuse approche. Sécurisation du trade recommandée.";
    } else if (rMultiple >= 1.5) {
      decision = "PARTIAL_EXIT";
      reason = "Le trade a dépassé 1.5R. Prise partielle et sécurisation recommandées.";
      partialClose = 50;
      newStopLoss = entry;
    } else if (rMultiple >= 1.0) {
      decision = "MOVE_TO_BREAKEVEN";
      reason = "Le trade a atteint 1R. Passage au break-even recommandé.";
      newStopLoss = entry;
    } else if (tpProgress >= 0.8 && confidence < 65) {
      decision = "PARTIAL_EXIT";
      reason = "Le trade est proche de son objectif mais la confiance reste moyenne.";
      partialClose = 30;
    } else if (Math.abs(momentum) < 0.08 && rMultiple > 0.5) {
      decision = "PARTIAL_EXIT";
      reason = "Le momentum s’essouffle. Sécurisation partielle conseillée.";
      partialClose = 25;
    } else {
      const trailDistance = atr14 * 1.2;
      if (rMultiple > 1.2) {
        decision = "TRAIL_STOP";
        reason = "Le trade avance bien. Trailing stop recommandé.";
        newStopLoss = direction === "buy"
          ? Math.max(stopLoss, currentPrice - trailDistance)
          : Math.min(stopLoss, currentPrice + trailDistance);
      }
    }

    return json({
      ok: true,
      pair,
      direction,
      decision,
      reason,
      rMultiple: round4(rMultiple),
      tpProgress: round4(tpProgress),
      partialClosePercent: partialClose,
      newStopLoss: roundPrice(newStopLoss, pair)
    });
  } catch {
    return json({ ok: false, error: "Server error" }, 500);
  }
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function cleanText(value, fallback) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 50) : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function roundPrice(value, pair) {
  if (pair === "XAUUSD") return Number(value.toFixed(2));
  if (pair === "NAS100" || pair === "GER40") return Number(value.toFixed(1));
  if (pair.includes("JPY")) return Number(value.toFixed(3));
  return Number(value.toFixed(5));
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
