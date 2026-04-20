export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    const accountSize = clamp(Number(body.accountSize) || 10000, 1000, 1000000);
    const dailyLossLimitPercent = clamp(Number(body.dailyLossLimitPercent) || 5, 0.5, 20);
    const totalLossLimitPercent = clamp(Number(body.totalLossLimitPercent) || 10, 1, 50);
    const openRiskPercent = clamp(Number(body.openRiskPercent) || 0, 0, 100);
    const closedTodayPnl = Number(body.closedTodayPnl) || 0;
    const floatingPnl = Number(body.floatingPnl) || 0;
    const requestedRiskPercent = clamp(Number(body.requestedRiskPercent) || 1, 0.1, 10);

    const dailyLossLimitValue = accountSize * (dailyLossLimitPercent / 100);
    const totalLossLimitValue = accountSize * (totalLossLimitPercent / 100);

    const usedDailyLoss = Math.max(0, Math.abs(Math.min(0, closedTodayPnl + floatingPnl)));
    const remainingDailyLoss = Math.max(0, dailyLossLimitValue - usedDailyLoss);

    const usedOpenRiskValue = accountSize * (openRiskPercent / 100);
    const requestedRiskValue = accountSize * (requestedRiskPercent / 100);

    const maxAdditionalRiskPercent = Math.max(
      0,
      Math.min(
        (remainingDailyLoss / accountSize) * 100,
        totalLossLimitPercent - openRiskPercent
      )
    );

    const allowed = requestedRiskValue <= remainingDailyLoss &&
      requestedRiskPercent <= maxAdditionalRiskPercent;

    return json({
      ok: true,
      accountSize,
      dailyLossLimitValue: round2(dailyLossLimitValue),
      totalLossLimitValue: round2(totalLossLimitValue),
      usedDailyLoss: round2(usedDailyLoss),
      remainingDailyLoss: round2(remainingDailyLoss),
      usedOpenRiskValue: round2(usedOpenRiskValue),
      requestedRiskValue: round2(requestedRiskValue),
      maxAdditionalRiskPercent: round2(maxAdditionalRiskPercent),
      allowed,
      decision: allowed ? "TRADE ALLOWED" : "TRADE BLOCKED",
      reason: allowed
        ? "Le risque demandé reste dans les limites définies."
        : "Le risque demandé dépasse la perte journalière restante ou l’exposition acceptable."
    });
  } catch {
    return json(
      {
        ok: false,
        error: "Invalid payload"
      },
      400
    );
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
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
