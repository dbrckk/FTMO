export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const pair = cleanPair(url.searchParams.get("pair"));
    const cooldownMinutes = clamp(Number(url.searchParams.get("cooldown")) || 90, 15, 240);
    const currencies = extractCurrenciesFromPair(pair);

    if (!currencies.length) {
      return json({
        ok: true,
        pair,
        cooldownMinutes,
        danger: false,
        source: "empty-pair",
        relevantEvents: [],
        dangerScore: 0
      });
    }

    const feed = await getMacroFeed(context.request);
    const now = new Date();

    const relevantEvents = (feed.events || [])
      .filter((evt) => currencies.includes(String(evt.currency || "").toUpperCase()))
      .map((evt) => {
        const date = new Date(evt.date);
        return {
          name: String(evt.name || "").slice(0, 120),
          currency: String(evt.currency || "").toUpperCase(),
          impact: normalizeImpact(evt.impact),
          date: date.toISOString(),
          minutesFromNow: Math.round((date.getTime() - now.getTime()) / 60000)
        };
      })
      .filter((evt) => Number.isFinite(evt.minutesFromNow))
      .sort((a, b) => Math.abs(a.minutesFromNow) - Math.abs(b.minutesFromNow))
      .slice(0, 12);

    const dangerScore = computeDangerScore(relevantEvents, cooldownMinutes);
    const danger = dangerScore >= 60;

    return json({
      ok: true,
      pair,
      cooldownMinutes,
      danger,
      dangerScore,
      source: feed.source || "macro-feed",
      relevantEvents
    });
  } catch {
    return json({
      ok: true,
      pair: "",
      cooldownMinutes: 90,
      danger: false,
      dangerScore: 0,
      source: "macro-context-catch",
      relevantEvents: []
    });
  }
}

async function getMacroFeed(request) {
  try {
    const url = new URL(request.url);
    url.pathname = "/api/macro-feed";
    url.search = "";

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    if (!res.ok) throw new Error("macro-feed failed");
    return await res.json();
  } catch {
    return {
      source: "macro-feed-fallback-empty",
      events: []
    };
  }
}

function computeDangerScore(events, cooldownMinutes) {
  let score = 0;

  for (const evt of events) {
    const minutes = Math.abs(Number(evt.minutesFromNow || 99999));
    const impact = normalizeImpact(evt.impact);

    if (impact === "high") {
      if (minutes <= cooldownMinutes) score += 70;
      else if (minutes <= cooldownMinutes * 2) score += 30;
    } else if (impact === "medium") {
      if (minutes <= cooldownMinutes) score += 35;
      else if (minutes <= cooldownMinutes * 2) score += 14;
    } else {
      if (minutes <= cooldownMinutes) score += 10;
    }
  }

  return Math.min(100, score);
}

function normalizeImpact(value) {
  const v = String(value || "").toLowerCase();
  if (v.includes("high")) return "high";
  if (v.includes("medium")) return "medium";
  return "low";
}

function extractCurrenciesFromPair(pair) {
  const specialMap = {
    XAUUSD: ["XAU", "USD"],
    NAS100: ["NAS", "USD"],
    GER40: ["GER", "EUR"]
  };

  if (specialMap[pair]) return specialMap[pair];

  if (/^[A-Z]{6}$/.test(pair)) {
    return [pair.slice(0, 3), pair.slice(3, 6)];
  }

  return [];
}

function cleanPair(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
