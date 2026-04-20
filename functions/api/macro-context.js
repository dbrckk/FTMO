export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const pair = String(url.searchParams.get("pair") || "").toUpperCase().trim();
    const currencies = extractCurrenciesFromPair(pair);

    if (!currencies.length) {
      return json({
        ok: true,
        pair,
        danger: false,
        source: "fallback-empty",
        relevantEvents: []
      });
    }

    const now = new Date();
    const fallbackEvents = buildFallbackEvents(now)
      .filter(evt => currencies.includes(evt.currency))
      .map(evt => ({
        ...evt,
        minutesFromNow: diffMinutes(now, new Date(evt.date))
      }));

    const danger = fallbackEvents.some(evt =>
      Math.abs(evt.minutesFromNow) <= 90 && evt.impact === "high"
    );

    return json({
      ok: true,
      pair,
      danger,
      source: "fallback-static",
      relevantEvents: fallbackEvents
    });
  } catch {
    return json({
      ok: true,
      pair: "",
      danger: false,
      source: "fallback-catch",
      relevantEvents: []
    });
  }
}

function buildFallbackEvents(now) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  return [
    event("US CPI", new Date(y, m, d, 14, 30), "USD", "high"),
    event("FOMC Member Speech", new Date(y, m, d, 18, 45), "USD", "medium"),
    event("UK CPI", new Date(y, m, d + 1, 8, 0), "GBP", "high"),
    event("EZ PMI", new Date(y, m, d + 1, 10, 0), "EUR", "medium"),
    event("BoJ Outlook", new Date(y, m, d + 2, 5, 0), "JPY", "high"),
    event("CAD Employment", new Date(y, m, d + 2, 14, 30), "CAD", "medium"),
    event("SNB Remarks", new Date(y, m, d + 3, 9, 30), "CHF", "medium"),
    event("RBA Minutes", new Date(y, m, d + 3, 3, 30), "AUD", "medium"),
    event("NZ GDP", new Date(y, m, d + 4, 0, 45), "NZD", "high"),
    event("Gold Volatility Proxy", new Date(y, m, d, 15, 0), "XAU", "medium"),
    event("US Tech Risk Window", new Date(y, m, d, 16, 0), "NAS", "medium"),
    event("EU Equity Risk Window", new Date(y, m, d, 11, 0), "GER", "medium")
  ];
}

function event(name, date, currency, impact) {
  return {
    name,
    date: date.toISOString(),
    currency,
    impact
  };
}

function extractCurrenciesFromPair(pair) {
  const specialMap = {
    XAUUSD: ["XAU", "USD"],
    NAS100: ["NAS", "USD"],
    GER40: ["GER", "EUR"]
  };

  if (specialMap[pair]) return specialMap[pair];

  if (pair.length >= 6) {
    return [pair.slice(0, 3), pair.slice(3, 6)];
  }

  return [];
}

function diffMinutes(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 60000);
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
