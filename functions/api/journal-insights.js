export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    if (!body.ok) {
      return json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    const trades = Array.isArray(body.data?.trades) ? body.data.trades : [];
    const normalizedTrades = trades
      .map(normalizeTrade)
      .filter((t) => t && Number.isFinite(t.entry) && Number.isFinite(t.exitPrice));

    if (!normalizedTrades.length) {
      return json({
        ok: true,
        totalTrades: 0,
        winRate: 0,
        expectancy: 0,
        pairStats: [],
        hourStats: [],
        sessionStats: [],
        bestPair: null,
        bestHour: null,
        worstHour: null,
        bestSession: null,
        worstSession: null,
        insights: ["Pas assez de données pour produire des insights."]
      });
    }

    const enriched = normalizedTrades.map((trade) => {
      const pnl = computePnl(trade);
      const win = pnl > 0 ? 1 : 0;
      const expectancy = pnl;

      const tradeDate = trade.createdAtDate || new Date();
      const hour = Number(
        tradeDate.toLocaleString("en-GB", {
          hour: "2-digit",
          hour12: false,
          timeZone: "Europe/Paris"
        })
      );

      const session = getSessionLabel(hour);

      return {
        ...trade,
        pnl,
        win,
        expectancy,
        hour,
        session
      };
    });

    const pairStats = aggregateBy(enriched, (t) => t.pair);
    const hourStats = aggregateBy(enriched, (t) => String(t.hour));
    const sessionStats = aggregateBy(enriched, (t) => t.session);

    const bestPair = maxBy(pairStats, "expectancy");
    const bestHour = maxBy(hourStats, "expectancy");
    const worstHour = minBy(hourStats, "expectancy");
    const bestSession = maxBy(sessionStats, "expectancy");
    const worstSession = minBy(sessionStats, "expectancy");

    const winRate =
      (enriched.reduce((sum, t) => sum + t.win, 0) / enriched.length) * 100;

    const expectancy =
      enriched.reduce((sum, t) => sum + t.expectancy, 0) / enriched.length;

    const insights = buildInsights({
      totalTrades: enriched.length,
      winRate,
      expectancy,
      bestPair,
      bestHour,
      worstHour,
      bestSession,
      worstSession
    });

    return json({
      ok: true,
      totalTrades: enriched.length,
      winRate: round(winRate, 2),
      expectancy: round(expectancy, 4),
      pairStats,
      hourStats,
      sessionStats,
      bestPair,
      bestHour,
      worstHour,
      bestSession,
      worstSession,
      insights
    });
  } catch {
    return json({
      ok: false,
      error: "Journal insights failed"
    }, 500);
  }
}

function normalizeTrade(trade) {
  const createdAtDate = safeDate(trade.createdAt);

  return {
    pair: cleanText(trade.pair, "UNKNOWN"),
    direction: String(trade.direction || "buy").toLowerCase() === "sell" ? "sell" : "buy",
    entry: Number(trade.entry),
    exitPrice: Number(trade.exitPrice ?? trade.currentPrice ?? trade.entry),
    createdAtDate
  };
}

function computePnl(trade) {
  if (trade.direction === "sell") {
    return trade.entry - trade.exitPrice;
  }
  return trade.exitPrice - trade.entry;
}

function aggregateBy(items, keyFn) {
  const map = new Map();

  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) {
      map.set(key, {
        key,
        total: 0,
        wins: 0,
        pnl: 0
      });
    }

    const bucket = map.get(key);
    bucket.total += 1;
    bucket.wins += item.win;
    bucket.pnl += item.pnl;
  }

  return [...map.values()]
    .map((bucket) => ({
      key: bucket.key,
      totalTrades: bucket.total,
      winRate: round(bucket.total > 0 ? (bucket.wins / bucket.total) * 100 : 0, 2),
      expectancy: round(bucket.total > 0 ? bucket.pnl / bucket.total : 0, 4)
    }))
    .sort((a, b) => b.expectancy - a.expectancy);
}

function buildInsights(data) {
  const insights = [];

  insights.push(`Win rate global: ${round(data.winRate, 2)}%.`);
  insights.push(`Expectancy globale: ${round(data.expectancy, 4)}.`);

  if (data.bestPair) {
    insights.push(`Meilleure paire actuelle: ${data.bestPair.key}.`);
  }

  if (data.bestHour) {
    insights.push(`Meilleure heure actuelle: ${data.bestHour.key}h.`);
  }

  if (data.worstHour) {
    insights.push(`Heure la plus faible: ${data.worstHour.key}h.`);
  }

  if (data.bestSession) {
    insights.push(`Meilleure session actuelle: ${data.bestSession.key}.`);
  }

  if (data.worstSession) {
    insights.push(`Session la plus faible: ${data.worstSession.key}.`);
  }

  if (data.expectancy <= 0) {
    insights.push("Le journal reste défensif : il faut réduire les setups moyens.");
  } else if (data.winRate >= 55) {
    insights.push("Le journal devient exploitable : l’avantage commence à se confirmer.");
  } else {
    insights.push("L’avantage est encore fragile : reste très sélectif.");
  }

  return insights;
}

function getSessionLabel(hour) {
  if (hour >= 9 && hour < 14) return "London";
  if (hour >= 14 && hour < 18) return "London+NewYork";
  if (hour >= 18 && hour < 23) return "NewYork";
  if (hour >= 1 && hour < 9) return "Tokyo";
  return "OffSession";
}

function maxBy(items, key) {
  if (!items.length) return null;
  return [...items].sort((a, b) => Number(b[key] || 0) - Number(a[key] || 0))[0];
}

function minBy(items, key) {
  if (!items.length) return null;
  return [...items].sort((a, b) => Number(a[key] || 0) - Number(b[key] || 0))[0];
}

function safeDate(value) {
  const d = new Date(value);
  if (Number.isFinite(d.getTime())) return d;
  return new Date();
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function cleanText(value, fallback) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 40) : fallback;
}

async function safeJson(request) {
  try {
    return { ok: true, data: await request.json() };
  } catch {
    return { ok: false };
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
