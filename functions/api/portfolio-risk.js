export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const positions = Array.isArray(body.positions) ? body.positions : [];

    const grouped = {
      USD: 0,
      EUR: 0,
      GBP: 0,
      JPY: 0,
      CHF: 0,
      CAD: 0,
      AUD: 0,
      NZD: 0,
      XAU: 0,
      IDX: 0
    };

    for (const p of positions) {
      const pair = String(p.pair || "").toUpperCase();
      const risk = Number(p.riskPercent || 0);

      if (pair === "XAUUSD") {
        grouped.XAU += risk;
        grouped.USD += risk * 0.5;
        continue;
      }

      if (pair === "NAS100" || pair === "GER40") {
        grouped.IDX += risk;
        continue;
      }

      const base = pair.slice(0, 3);
      const quote = pair.slice(3, 6);

      if (grouped[base] !== undefined) grouped[base] += risk;
      if (grouped[quote] !== undefined) grouped[quote] += risk;
    }

    const exposures = Object.entries(grouped)
      .map(([bucket, value]) => ({
        bucket,
        exposure: Number(value.toFixed(2))
      }))
      .sort((a, b) => b.exposure - a.exposure);

    const top = exposures[0] || { bucket: "NONE", exposure: 0 };
    const total = positions.reduce((sum, p) => sum + Number(p.riskPercent || 0), 0);

    let decision = "OK";
    let reason = "Portfolio exposure acceptable.";

    if (top.exposure >= 3.5 || total >= 4) {
      decision = "BLOCK";
      reason = "Portfolio too concentrated.";
    } else if (top.exposure >= 2.5 || total >= 3) {
      decision = "REDUCE";
      reason = "Portfolio concentration elevated.";
    }

    return json({
      ok: true,
      decision,
      reason,
      totalExposure: Number(total.toFixed(2)),
      topBucket: top.bucket,
      topBucketExposure: top.exposure,
      exposures
    });
  } catch {
    return json({
      ok: false,
      decision: "REDUCE",
      reason: "Portfolio risk engine unavailable."
    }, 500);
  }
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
