export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const trades = Array.isArray(body.trades) ? body.trades : [];

    const normalizedTrades = trades
      .map(normalizeTrade)
      .filter(Boolean);

    const byPair = groupBy(normalizedTrades, (t) => t.pair);
    const byHour = groupBy(normalizedTrades, (t) => String(t.hour));
    const bySession = groupBy(normalizedTrades, (t) => t.session);
    const byDirection = groupBy(normalizedTrades, (t) => t.direction);

    const pairStats = summarizeBuckets(byPair);
    const hourStats = summarizeBuckets(byHour);
    const sessionStats = summarizeBuckets(bySession);
    const directionStats = summarizeBuckets(byDirection);

    const bestPair = getBestBucket(pairStats);
    const worstPair = getWorstBucket(pairStats);
    const bestHour = getBestBucket(hourStats);
    const worstHour = getWorstBucket(hourStats);
    const bestSession = getBestBucket(sessionStats);
    const worstSession = getWorstBucket(sessionStats);
    const bestDirection = getBestBucket(directionStats);

    const insights = buildInsights({
      normalizedTrades,
      bestPair,
      worstPair,
      bestHour,
      worstHour,
      bestSession,
      worstSession,
      bestDirection
    });

    return json({
      ok: true,
      totalTrades: normalizedTrades.length,
      winRate: round2(computeWinRate(normalizedTrades)),
      expectancy: round4(computeExpectancy(normalizedTrades)),
      averageR: round4(computeAverageR(normalizedTrades)),
      bestPair,
      worstPair,
      bestHour,
      worstHour,
      bestSession,
      worstSession,
      bestDirection,
      insights,
      pairStats,
      hourStats,
      sessionStats
    });
  } catch {
    return json({ ok: false, error: "Invalid payload" }, 400);
  }
}

function normalizeTrade(t) {
  const pair = cleanText(t.pair, "");
  const direction = cleanText((t.direction || "").toLowerCase(), "buy");
  const status = cleanText((t.status || "").toLowerCase(), "actif");
  const notes = cleanText(t.notes, "");
  const createdAt = parseDate(t.createdAt);
  const entry = Number(t.entry);
  const stopLoss = Number(t.stopLoss);
  const takeProfit = Number(t.takeProfit);

  if (!pair || !createdAt || !Number.isFinite(entry)) return null;

  const currentPrice = Number(t.currentPrice || t.exitPrice || entry);
  const rr = estimateRMultiple({
    direction,
    entry,
    stopLoss,
    currentPrice
  });

  return {
    pair,
    direction,
    status,
    notes,
    createdAt,
    hour: createdAt.getHours(),
    session: detectSession(createdAt),
    rr,
    win: rr > 0,
    loss: rr < 0
  };
}

function estimateRMultiple({ direction, entry, stopLoss, currentPrice }) {
  const risk = Math.abs(entry - stopLoss) || Math.max(Math.abs(entry) * 0.002, 0.0001);
  const pnl = direction === "sell" ? entry - currentPrice : currentPrice - entry;
  return pnl / risk;
}

function detectSession(date) {
  const h = Number(date.toLocaleString("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Europe/Paris"
  }));

  if (h >= 1 && h < 10) return "Tokyo";
  if (h >= 9 && h < 14) return "London";
  if (h >= 14 && h < 18) return "London+NewYork";
  if (h >= 18 && h < 23) return "NewYork";
  return "OffSession";
}

function groupBy(items, fn) {
  return items.reduce((acc, item) => {
    const key = fn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

function summarizeBuckets(grouped) {
  return Object.entries(grouped).map(([key, items]) => ({
    key,
    count: items.length,
    winRate: round2(computeWinRate(items)),
    expectancy: round4(computeExpectancy(items)),
    averageR: round4(computeAverageR(items))
  })).sort((a, b) => b.expectancy - a.expectancy);
}

function getBestBucket(stats) {
  return stats.length ? stats[0] : null;
}

function getWorstBucket(stats) {
  return stats.length ? stats[stats.length - 1] : null;
}

function computeWinRate(items) {
  if (!items.length) return 0;
  return (items.filter((x) => x.win).length / items.length) * 100;
}

function computeAverageR(items) {
  if (!items.length) return 0;
  return items.reduce((sum, x) => sum + x.rr, 0) / items.length;
}

function computeExpectancy(items) {
  if (!items.length) return 0;
  const wins = items.filter((x) => x.win);
  const losses = items.filter((x) => x.loss);

  const avgWin = wins.length ? wins.reduce((s, x) => s + x.rr, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, x) => s + x.rr, 0) / losses.length) : 0;
  const winRate = wins.length / items.length;
  const lossRate = losses.length / items.length;

  return (winRate * avgWin) - (lossRate * avgLoss);
}

function buildInsights(ctx) {
  const insights = [];

  if (ctx.bestPair) {
    insights.push(`Meilleure paire: ${ctx.bestPair.key} · expectancy ${ctx.bestPair.expectancy}`);
  }
  if (ctx.worstPair) {
    insights.push(`Paire la plus faible: ${ctx.worstPair.key} · expectancy ${ctx.worstPair.expectancy}`);
  }
  if (ctx.bestHour) {
    insights.push(`Meilleure heure: ${ctx.bestHour.key}h · win rate ${ctx.bestHour.winRate}%`);
  }
  if (ctx.worstHour) {
    insights.push(`Heure à éviter: ${ctx.worstHour.key}h · expectancy ${ctx.worstHour.expectancy}`);
  }
  if (ctx.bestSession) {
    insights.push(`Meilleure session: ${ctx.bestSession.key}`);
  }
  if (ctx.worstSession) {
    insights.push(`Session la plus faible: ${ctx.worstSession.key}`);
  }
  if (ctx.bestDirection) {
    insights.push(`Direction la plus rentable: ${ctx.bestDirection.key}`);
  }

  const earlyEntries = ctx.normalizedTrades.filter((t) => t.notes.toLowerCase().includes("early")).length;
  if (earlyEntries >= 2) {
    insights.push("Tu entres souvent trop tôt sur certains trades.");
  }

  const offSessionCount = ctx.normalizedTrades.filter((t) => t.session === "OffSession").length;
  if (offSessionCount >= 2) {
    insights.push("Tu trades trop souvent hors session active.");
  }

  return insights;
}

function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function cleanText(value, fallback) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 120) : fallback;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
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
