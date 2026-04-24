export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const trade = normalizeTrade(body);

    if (!trade.id || !trade.pair || !trade.timeframe || !trade.direction) {
      return json({ ok: false, error: "missing-fields" }, 400);
    }

    await context.env.DB
      .prepare(`
        INSERT OR REPLACE INTO paper_trades (
          id,
          pair,
          timeframe,
          direction,
          opened_at,
          closed_at,
          entry,
          exit,
          stop_loss,
          take_profit,
          pnl,
          pnl_r,
          win,
          session,
          hour,
          ultra_score,
          ml_score,
          vectorbt_score,
          archive_edge_score,
          close_reason,
          source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        trade.id,
        trade.pair,
        trade.timeframe,
        trade.direction,
        trade.openedAt,
        trade.closedAt,
        trade.entry,
        trade.exitPrice,
        trade.stopLoss,
        trade.takeProfit,
        trade.pnl,
        trade.pnlR,
        trade.win,
        trade.session,
        trade.hour,
        trade.entryUltraScore,
        trade.entryMlScore,
        trade.entryVectorbtScore,
        trade.entryArchiveEdgeScore,
        trade.closeReason,
        trade.source || "paper-engine"
      )
      .run();

    return json({ ok: true, id: trade.id });
  } catch (error) {
    return json(
      { ok: false, error: String(error?.message || error || "paper-trades-post-error") },
      500
    );
  }
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const mode = String(url.searchParams.get("mode") || "recent").toLowerCase();
    const timeframe = String(url.searchParams.get("timeframe") || "").toUpperCase();
    const pair = String(url.searchParams.get("pair") || "").toUpperCase();

    if (mode === "recent") {
      const { query, binds } = buildRecentQuery({ timeframe, pair, limit: 50 });

      const res = await context.env.DB
        .prepare(query)
        .bind(...binds)
        .all();

      return json({
        ok: true,
        mode,
        results: res.results || []
      });
    }

    if (mode === "summary") {
      const { query, binds } = buildSummaryQuery({ timeframe, pair });

      const res = await context.env.DB
        .prepare(query)
        .bind(...binds)
        .first();

      const summary = {
        trades: Number(res?.trades || 0),
        wins: Number(res?.wins || 0),
        expectancy: Number(res?.expectancy || 0),
        pnl: Number(res?.pnl || 0),
        winRate:
          Number(res?.trades || 0) > 0
            ? Number((((Number(res?.wins || 0) / Number(res?.trades || 0)) * 100)).toFixed(2))
            : 0
      };

      return json({
        ok: true,
        mode,
        summary
      });
    }

    if (mode === "pair-stats") {
      const { query, binds } = buildPairStatsQuery({ timeframe });

      const res = await context.env.DB
        .prepare(query)
        .bind(...binds)
        .all();

      return json({
        ok: true,
        mode,
        results: (res.results || []).map((row) => ({
          pair: row.pair,
          trades: Number(row.trades || 0),
          wins: Number(row.wins || 0),
          winRate: Number(row.trades || 0)
            ? Number((((Number(row.wins || 0) / Number(row.trades || 0)) * 100)).toFixed(2))
            : 0,
          expectancy: Number(row.expectancy || 0),
          pnl: Number(row.pnl || 0)
        }))
      });
    }

    return json({ ok: false, error: "unsupported-mode" }, 400);
  } catch (error) {
    return json(
      { ok: false, error: String(error?.message || error || "paper-trades-get-error") },
      500
    );
  }
}

function buildRecentQuery({ timeframe, pair, limit }) {
  const where = [];
  const binds = [];

  if (timeframe) {
    where.push("timeframe = ?");
    binds.push(timeframe);
  }

  if (pair) {
    where.push("pair = ?");
    binds.push(pair);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const query = `
    SELECT
      pair,
      timeframe,
      direction,
      pnl_r,
      pnl,
      close_reason,
      closed_at,
      ultra_score,
      ml_score,
      vectorbt_score,
      archive_edge_score
    FROM paper_trades
    ${whereSql}
    ORDER BY closed_at DESC
    LIMIT ${Number(limit || 50)}
  `;

  return { query, binds };
}

function buildSummaryQuery({ timeframe, pair }) {
  const where = [];
  const binds = [];

  if (timeframe) {
    where.push("timeframe = ?");
    binds.push(timeframe);
  }

  if (pair) {
    where.push("pair = ?");
    binds.push(pair);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const query = `
    SELECT
      COUNT(*) AS trades,
      SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
      ROUND(AVG(pnl_r), 4) AS expectancy,
      ROUND(SUM(pnl), 2) AS pnl
    FROM paper_trades
    ${whereSql}
  `;

  return { query, binds };
}

function buildPairStatsQuery({ timeframe }) {
  const where = [];
  const binds = [];

  if (timeframe) {
    where.push("timeframe = ?");
    binds.push(timeframe);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const query = `
    SELECT
      pair,
      COUNT(*) AS trades,
      SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
      ROUND(AVG(pnl_r), 4) AS expectancy,
      ROUND(SUM(pnl), 2) AS pnl
    FROM paper_trades
    ${whereSql}
    GROUP BY pair
    ORDER BY expectancy DESC, trades DESC
  `;

  return { query, binds };
}

function normalizeTrade(raw) {
  return {
    id: String(raw.id || ""),
    pair: String(raw.pair || "").toUpperCase(),
    timeframe: String(raw.timeframe || "M15").toUpperCase(),
    direction: String(raw.direction || "buy").toLowerCase(),
    openedAt: String(raw.openedAt || new Date().toISOString()),
    closedAt: String(raw.closedAt || new Date().toISOString()),
    entry: Number(raw.entry || 0),
    exitPrice: Number(raw.exitPrice || raw.exit || 0),
    stopLoss: Number(raw.stopLoss || 0),
    takeProfit: Number(raw.takeProfit || 0),
    pnl: Number(raw.pnl || 0),
    pnlR: Number(raw.pnlR || 0),
    win: Number(raw.win || 0) === 1 ? 1 : (Number(raw.pnlR || 0) > 0 ? 1 : 0),
    session: String(raw.session || "OffSession"),
    hour: Number(raw.hour || 0),
    entryUltraScore: Number(raw.entryUltraScore || raw.ultraScore || 0),
    entryMlScore: Number(raw.entryMlScore || raw.mlScore || 0),
    entryVectorbtScore: Number(raw.entryVectorbtScore || raw.vectorbtScore || 0),
    entryArchiveEdgeScore: Number(raw.entryArchiveEdgeScore || raw.archiveEdgeScore || 0),
    closeReason: String(raw.closeReason || ""),
    source: String(raw.source || "paper-engine")
  };
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
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
