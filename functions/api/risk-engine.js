export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    if (!body.ok) {
      return json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    const payload = normalizePayload(body.data);

    const dailyLossLimitValue =
      payload.accountSize * (payload.dailyLossLimitPercent / 100);

    const totalLossLimitValue =
      payload.accountSize * (payload.totalLossLimitPercent / 100);

    const remainingDailyLoss =
      dailyLossLimitValue + payload.closedTodayPnl + payload.floatingPnl;

    const maxAdditionalRiskValue =
      Math.max(0, remainingDailyLoss - payload.openRiskValue);

    const maxAdditionalRiskPercent =
      payload.accountSize > 0
        ? (maxAdditionalRiskValue / payload.accountSize) * 100
        : 0;

    const totalDrawdownValue =
      Math.abs(Math.min(0, payload.closedTodayPnl + payload.floatingPnl));

    let allowed = true;
    let decision = "TRADE ALLOWED";
    let reason = "Le risque demandé reste dans les limites FTMO.";

    if (remainingDailyLoss <= 0) {
      allowed = false;
      decision = "TRADE BLOCKED";
      reason = "La limite de perte journalière est déjà atteinte.";
    } else if (totalDrawdownValue >= totalLossLimitValue) {
      allowed = false;
      decision = "TRADE BLOCKED";
      reason = "La limite de perte totale est déjà atteinte.";
    } else if (payload.requestedRiskValue > maxAdditionalRiskValue) {
      allowed = false;
      decision = "TRADE BLOCKED";
      reason = "Le risque demandé dépasse le risque encore autorisé.";
    } else if (payload.requestedRiskPercent > 1.5) {
      allowed = false;
      decision = "WAIT";
      reason = "Le risque demandé est trop agressif pour une prop firm stricte.";
    }

    return json({
      ok: true,
      allowed,
      decision,
      reason,
      accountSize: payload.accountSize,
      dailyLossLimitValue,
      totalLossLimitValue,
      closedTodayPnl: payload.closedTodayPnl,
      floatingPnl: payload.floatingPnl,
      remainingDailyLoss,
      openRiskPercent: payload.openRiskPercent,
      openRiskValue: payload.openRiskValue,
      requestedRiskPercent: payload.requestedRiskPercent,
      requestedRiskValue: payload.requestedRiskValue,
      maxAdditionalRiskValue,
      maxAdditionalRiskPercent
    });
  } catch {
    return json({
      ok: false,
      allowed: false,
      decision: "WAIT",
      reason: "Impossible de calculer le risque."
    }, 500);
  }
}

function normalizePayload(data) {
  const accountSize = clampNumber(data.accountSize, 100, 100000000, 10000);
  const dailyLossLimitPercent = clampNumber(data.dailyLossLimitPercent, 0.1, 100, 5);
  const totalLossLimitPercent = clampNumber(data.totalLossLimitPercent, 0.1, 100, 10);
  const openRiskPercent = clampNumber(data.openRiskPercent, 0, 100, 0);
  const requestedRiskPercent = clampNumber(data.requestedRiskPercent, 0, 100, 1);

  return {
    accountSize,
    dailyLossLimitPercent,
    totalLossLimitPercent,
    closedTodayPnl: Number(data.closedTodayPnl) || 0,
    floatingPnl: Number(data.floatingPnl) || 0,
    openRiskPercent,
    openRiskValue: accountSize * (openRiskPercent / 100),
    requestedRiskPercent,
    requestedRiskValue: accountSize * (requestedRiskPercent / 100)
  };
}

async function safeJson(request) {
  try {
    return { ok: true, data: await request.json() };
  } catch {
    return { ok: false };
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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
