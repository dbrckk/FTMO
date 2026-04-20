export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const pair = cleanPair(url.searchParams.get("pair"));
    const cooldownMinutes = clamp(Number(url.searchParams.get("cooldown")) || 90, 15, 360);
    const currencies = extractCurrenciesFromPair(pair);

    if (!currencies.length) {
      return json({
        ok: true,
        pair,
        cooldownMinutes,
        danger: false,
        hardBlock: false,
        dangerScore: 0,
        source: "empty-pair",
        relevantEvents: []
      });
    }

    const feed = await getMacroFeed(context.request);
    const now = new Date();

    const relevantEvents = (feed.events || [])
      .filter((evt) => currencies.includes(String(evt.currency || "").toUpperCase()))
      .map((evt) => {
        const date = new Date(evt.date);
        return {
          name: String(evt.name || "").slice(0, 140),
          currency: String(evt.currency || "").toUpperCase(),
          impact: normalizeImpact(evt.impact),
          severity: detectSeverity(evt.name),
          date: date.toISOString(),
          minutesFromNow: Math.round((date.getTime() - now.getTime()) / 60000)
        };
      })
      .filter((evt) => Number.isFinite(evt.minutesFromNow))
      .sort((a, b) => Math.abs(a.minutesFromNow) - Math.abs(b.minutesFromNow))
      .slice(0, 12);

    const dangerScore = computeDangerScore(relevantEvents, cooldownMinutes);
    const hardBlock = shouldHardBlock(relevantEvents, cooldownMinutes);
    const danger = hardBlock || dangerScore >= 60;

    return json({
      ok: true,
      pair,
      cooldownMinutes,
      danger,
      hardBlock,
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
      hardBlock: false,
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
      headers: { Accept: "application/json" }
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
    const severity = evt.severity || "normal";

    if (impact === "high") {
      if (severity === "major") {
        if (minutes <= cooldownMinutes) score += 95;
        else if (minutes <= cooldownMinutes * 2) score += 45;
      } else {
        if (minutes <= cooldownMinutes) score += 70;
        else if (minutes <= cooldownMinutes * 2) score += 30;
      }
    } else if (impact === "medium") {
      if (minutes <= cooldownMinutes) score += 35;
      else if (minutes <= cooldownMinutes * 2) score += 14;
    } else {
      if (minutes <= cooldownMinutes) score += 10;
    }
  }

  return Math.min(100, score);
}

function shouldHardBlock(events, cooldownMinutes) {
  return events.some((evt) => {
    const minutes = Math.abs(Number(evt.minutesFromNow || 99999));
    const isHigh = evt.impact === "high";
    const isMajor = evt.severity === "major";

    if (isMajor && minutes <= cooldownMinutes * 1.5) return true;
    if (isHigh && minutes <= Math.min(cooldownMinutes, 90)) return true;
    return false;
  });
}

function detectSeverity(name) {
  const n = String(name || "").toLowerCase();

  if (
    n.includes("cpi") ||
    n.includes("nfp") ||
    n.includes("nonfarm") ||
    n.includes("fomc") ||
    n.includes("interest rate") ||
    n.includes("rate decision") ||
    n.includes("inflation") ||
    n.includes("employment") ||
    n.includes("powell") ||
    n.includes("ecb") ||
    n.includes("boj") ||
    n.includes("boe")
  ) {
    return "major";
  }

  return "normal";
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
