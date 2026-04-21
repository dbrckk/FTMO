export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const pair = cleanPair(url.searchParams.get("pair"));
    const cooldownMinutes = clampInt(url.searchParams.get("cooldown"), 15, 360, 90);

    const now = new Date();
    const events = buildEconomicEvents(now);
    const relevantEvents = events
      .filter((evt) => isRelevantForPair(evt.currency, pair))
      .map((evt) => ({
        ...evt,
        minutesToEvent: Math.round((evt.timestamp - now.getTime()) / 60000)
      }))
      .sort((a, b) => Math.abs(a.minutesToEvent) - Math.abs(b.minutesToEvent));

    let dangerScore = 0;
    let hardBlock = false;
    let danger = false;

    for (const evt of relevantEvents) {
      const absMinutes = Math.abs(evt.minutesToEvent);

      if (evt.impact === "high" && absMinutes <= cooldownMinutes) {
        dangerScore += 38;
      } else if (evt.impact === "medium" && absMinutes <= Math.round(cooldownMinutes * 0.75)) {
        dangerScore += 18;
      } else if (evt.impact === "low" && absMinutes <= Math.round(cooldownMinutes * 0.5)) {
        dangerScore += 6;
      }

      if (evt.impact === "high" && absMinutes <= Math.round(cooldownMinutes * 0.5)) {
        hardBlock = true;
      }
    }

    dangerScore = Math.max(0, Math.min(100, dangerScore));
    danger = dangerScore >= 45 || hardBlock;

    return json({
      ok: true,
      pair,
      source: "macro-context-v1",
      danger,
      hardBlock,
      dangerScore,
      cooldownMinutes,
      relevantEvents: relevantEvents.slice(0, 8)
    });
  } catch {
    return json({
      ok: true,
      pair: "",
      source: "macro-context-fallback",
      danger: false,
      hardBlock: false,
      dangerScore: 0,
      cooldownMinutes: 90,
      relevantEvents: []
    });
  }
}

function buildEconomicEvents(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  const base = [
    { name: "CPI", currency: "USD", impact: "high", hourUtc: 12, minuteUtc: 30 },
    { name: "NFP", currency: "USD", impact: "high", hourUtc: 12, minuteUtc: 30 },
    { name: "FOMC", currency: "USD", impact: "high", hourUtc: 18, minuteUtc: 0 },
    { name: "ECB Rate Decision", currency: "EUR", impact: "high", hourUtc: 12, minuteUtc: 15 },
    { name: "BoE Rate Decision", currency: "GBP", impact: "high", hourUtc: 11, minuteUtc: 0 },
    { name: "BoJ Statement", currency: "JPY", impact: "high", hourUtc: 3, minuteUtc: 0 },
    { name: "Retail Sales", currency: "USD", impact: "medium", hourUtc: 12, minuteUtc: 30 },
    { name: "PMI", currency: "EUR", impact: "medium", hourUtc: 8, minuteUtc: 0 },
    { name: "GDP", currency: "GBP", impact: "medium", hourUtc: 6, minuteUtc: 0 },
    { name: "Employment Change", currency: "AUD", impact: "medium", hourUtc: 1, minuteUtc: 30 }
  ];

  return base.map((evt, index) => ({
    ...evt,
    timestamp: Date.UTC(y, m, d, evt.hourUtc, evt.minuteUtc + index)
  }));
}

function isRelevantForPair(currency, pair) {
  if (!pair) return false;
  if (pair === "XAUUSD" || pair === "NAS100") return currency === "USD";
  if (pair === "GER40") return currency === "EUR";
  return pair.includes(currency);
}

function cleanPair(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
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
