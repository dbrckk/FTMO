export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const timeframe = String(url.searchParams.get("timeframe") || "M15").toUpperCase();

    const rowsResult = await context.env.DB
      .prepare(`
        SELECT
          pair,
          timeframe,
          direction,
          closed_at,
          pnl_r,
          win,
          session,
          hour
        FROM paper_trades
        WHERE timeframe = ?
        ORDER BY closed_at DESC
        LIMIT 8000
      `)
      .bind(timeframe)
      .all();

    const rows = Array.isArray(rowsResult.results) ? rowsResult.results : [];
    const stats = buildStats(rows);

    return json({
      ok: true,
      timeframe,
      count: rows.length,
      stats
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "archive-stats-error"),
      stats: {}
    }, 500);
  }
}

function buildStats(rows) {
  const grouped = {};

  for (const row of rows) {
    const pair = String(row.pair || "").toUpperCase();
    if (!pair) continue;

    if (!grouped[pair]) grouped[pair] = [];

    grouped[pair].push({
      direction: String(row.direction || "buy").toLowerCase(),
      closedAt: row.closed_at,
      pnlR: Number(row.pnl_r || 0),
      win: Number(row.win || 0) === 1,
      session: String(row.session || "OffSession"),
      hour: Number(row.hour || 0)
    });
  }

  const out = {};

  for (const [pair, trades] of Object.entries(grouped)) {
    const directions = { buy: [], sell: [] };
    const sessions = {};
    const hours = {};

    for (const trade of trades) {
      if (directions[trade.direction]) directions[trade.direction].push(trade);

      if (!sessions[trade.session]) sessions[trade.session] = [];
      sessions[trade.session].push(trade);

      const hourKey = String(trade.hour);
      if (!hours[hourKey]) hours[hourKey] = [];
      hours[hourKey].push(trade);
    }

    out[pair] = {
      pairTradesCount: trades.length,
      pairWinRate: winRate(trades),
      pairExpectancy: expectancy(trades),
      last20WinRate: winRate(trades.slice(0, 20)),
      last20Expectancy: expectancy(trades.slice(0, 20)),
      archiveConfidence: Math.min(99, trades.length),
      directions: {
        buy: pack(directions.buy),
        sell: pack(directions.sell)
      },
      sessions: Object.fromEntries(
        Object.entries(sessions).map(([key, value]) => [key, pack(value)])
      ),
      hours: Object.fromEntries(
        Object.entries(hours).map(([key, value]) => [key, pack(value)])
      )
    };
  }

  return out;
}

function pack(trades) {
  return {
    trades: trades.length,
    winRate: winRate(trades),
    expectancy: expectancy(trades)
  };
}

function winRate(trades) {
  if (!trades.length) return 50;
  const wins = trades.filter((t) => t.win || Number(t.pnlR || 0) > 0).length;
  return Number(((wins / trades.length) * 100).toFixed(2));
}

function expectancy(trades) {
  if (!trades.length) return 0;
  const total = trades.reduce((sum, t) => sum + Number(t.pnlR || 0), 0);
  return Number((total / trades.length).toFixed(4));
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
