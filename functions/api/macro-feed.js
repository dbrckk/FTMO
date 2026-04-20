export async function onRequestGet(context) {
  try {
    const env = context.env || {};
    const apiKey = env.FMP_API_KEY || "";
    const now = new Date();
    const from = formatDate(now);
    const to = formatDate(addDays(now, 7));

    if (!apiKey) {
      return json({
        ok: true,
        source: "fallback-no-fmp-key",
        events: buildFallbackEvents(now)
      });
    }

    const url =
      `https://financialmodelingprep.com/stable/economic-calendar` +
      `?from=${encodeURIComponent(from)}` +
      `&to=${encodeURIComponent(to)}` +
      `&apikey=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    if (!res.ok) {
      return json({
        ok: true,
        source: "fallback-fmp-http",
        events: buildFallbackEvents(now)
      });
    }

    const data = await res.json();

    if (!Array.isArray(data)) {
      return json({
        ok: true,
        source: "fallback-fmp-invalid",
        events: buildFallbackEvents(now)
      });
    }

    const events = data
      .map(normalizeFmpEvent)
      .filter(Boolean)
      .slice(0, 200);

    return json({
      ok: true,
      source: "fmp-economic-calendar",
      events: events.length ? events : buildFallbackEvents(now)
    });
  } catch {
    return json({
      ok: true,
      source: "fallback-catch",
      events: buildFallbackEvents(new Date())
    });
  }
}

function normalizeFmpEvent(item) {
  const currency = String(item.currency || "").toUpperCase().trim();
  const name = String(item.event || item.name || "").trim();
  const dateRaw = item.date || item.datetime || item.timestamp;

  if (!currency || !name || !dateRaw) return null;

  const date = new Date(dateRaw);
  if (Number.isNaN(date.getTime())) return null;

  return {
    name: name.slice(0, 120),
    currency,
    impact: normalizeImpact(item.impact || item.importance || item.priority),
    date: date.toISOString()
  };
}

function normalizeImpact(value) {
  const v = String(value || "").toLowerCase();
  if (v.includes("high") || v.includes("3") || v.includes("red")) return "high";
  if (v.includes("medium") || v.includes("2") || v.includes("orange")) return "medium";
  return "low";
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
    event("Swiss CPI", new Date(y, m, d + 3, 8, 30), "CHF", "medium"),
    event("Australian Employment", new Date(y, m, d + 3, 2, 30), "AUD", "high"),
    event("NZ GDP", new Date(y, m, d + 4, 0, 45), "NZD", "high"),
    event("Gold Volatility Window", new Date(y, m, d, 15, 0), "XAU", "medium"),
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

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
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
