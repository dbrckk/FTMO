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

    if (mode === "snapshot") {
      const open = await getOpenTrades(context.env.DB, { timeframe, pair });
      const recent = await getRecentClosedTrades(context.env.DB, { timeframe, pair, limit: 40 });
      const summary = await getSummary(context.env.DB, { timeframe, pair });
      const pairStats = await getPairStats(context.env.DB, { timeframe });
      const runs = await getRecentRuns(context.env.DB, { limit: 10 });

      return json({
        ok: true,
        mode,
        open,
        recent,
        summary,
        pairStats,
        runs
      });
    }

    if (mode === "open") {
      const open = await getOpenTrades(context.env.DB, { timeframe, pair });

      return json({
        ok: true,
        mode,
        results: open
      });
    }

    if (mode === "recent") {
      const recent = await getRecentClosedTrades(context.env.DB, { timeframe, pair, limit: 50 });

      return json({
        ok: true,
        mode,
        results: recent
      });
    }

    if (mode === "summary") {
      const summary = await getSummary(context.env.DB, { timeframe, pair });

      return json({
        ok: true,
        mode,
        summary
      });
    }

    if (mode === "pair-stats") {
      const pairStats = await getPairStats(context.env.DB, { timeframe });

      return json({
        ok: true,
        mode,
        results: pairStats
      });
    }

    if (mode === "runs") {
      const runs = await getRecentRuns(context.env.DB, { limit: 25 });

      return json({
        ok: true,
        mode,
        results: runs
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

async function getOpenTrades(db, { timeframe, pair }) {
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

  const res = await db
    .prepare(`
      SELECT
        id,
        pair,
        timeframe,
        direction,
        opened_at,
        entry,
        stop_loss,
        take_profit,
        current_price,
        risk_percent,
        rr,
        bars_held,
        max_bars_hold,
        ultra_score,
        ml_score,
        archive_edge_score,
        session,
        hour,
        model_tag,
        source
      FROM paper_open_trades
      ${whereSql}
      ORDER BY opened_at DESC
      LIMIT 100
    `)
    .bind(...binds)
    .all();

  return (res.results || []).map((row) => ({
    id: row.id,
    pair: row.pair,
    timeframe: row.timeframe,
    direction: row.direction,
    openedAt: row.opened_at,
    entry: Number(row.entry || 0),
    stopLoss: Number(row.stop_loss || 0),
    takeProfit: Number(row.take_profit || 0),
    currentPrice: Number(row.current_price || 0),
    riskPercent: Number(row.risk_percent || 0),
    rr: Number(row.rr || 0),
    barsHeld: Number(row.bars_held || 0),
    maxBarsHold: Number(row.max_bars_hold || 0),
    ultraScore: Number(row.ultra_score || 0),
    mlScore: Number(row.ml_score || 0),
    archiveEdgeScore: Number(row.archive_edge_score || 0),
    session: row.session || "OffSession",
    hour: Number(row.hour || 0),
    modelTag: row.model_tag || "server-paper",
    source: row.source || "server-paper",
    pnlRLive: computeLivePnlR(row)
  }));
}

async function getRecentClosedTrades(db, { timeframe, pair, limit }) {
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

  const res = await db
    .prepare(`
      SELECT
        id,
        pair,
        timeframe,
        direction,
        pnl_r,
        pnl,
        win,
        close_reason,
        opened_at,
        closed_at,
        entry,
        exit,
        stop_loss,
        take_profit,
        ultra_score,
        ml_score,
        vectorbt_score,
        archive_edge_score,
        session,
        hour,
        source
      FROM paper_trades
      ${whereSql}
      ORDER BY closed_at DESC
      LIMIT ${Number(limit || 50)}
    `)
    .bind(...binds)
    .all();

  return (res.results || []).map((row) => ({
    id: row.id,
    pair: row.pair,
    timeframe: row.timeframe,
    direction: row.direction,
    pnlR: Number(row.pnl_r || 0),
    pnl: Number(row.pnl || 0),
    win: Number(row.win || 0),
    closeReason: row.close_reason || "",
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    entry: Number(row.entry || 0),
    exitPrice: Number(row.exit || 0),
    stopLoss: Number(row.stop_loss || 0),
    takeProfit: Number(row.take_profit || 0),
    ultraScore: Number(row.ultra_score || 0),
    mlScore: Number(row.ml_score || 0),
    vectorbtScore: Number(row.vectorbt_score || 0),
    archiveEdgeScore: Number(row.archive_edge_score || 0),
    session: row.session || "OffSession",
    hour: Number(row.hour || 0),
    source: row.source || "paper-engine"
  }));
}

async function getSummary(db, { timeframe, pair }) {
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

  const res = await db
    .prepare(`
      SELECT
        COUNT(*) AS trades,
        SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
        ROUND(AVG(pnl_r), 4) AS expectancy,
        ROUND(SUM(pnl), 2) AS pnl
      FROM paper_trades
      ${whereSql}
    `)
    .bind(...binds)
    .first();

  const trades = Number(res?.trades || 0);
  const wins = Number(res?.wins || 0);

  return {
    trades,
    wins,
    losses: Math.max(0, trades - wins),
    expectancy: Number(res?.expectancy || 0),
    pnl: Number(res?.pnl || 0),
    winRate: trades > 0 ? Number(((wins / trades) * 100).toFixed(2)) : 0
  };
}

async function getPairStats(db, { timeframe }) {
  const where = [];
  const binds = [];

  if (timeframe) {
    where.push("timeframe = ?");
    binds.push(timeframe);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const res = await db
    .prepare(`
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
      LIMIT 50
    `)
    .bind(...binds)
    .all();

  return (res.results || []).map((row) => ({
    pair: row.pair,
    trades: Number(row.trades || 0),
    wins: Number(row.wins || 0),
    losses: Math.max(0, Number(row.trades || 0) - Number(row.wins || 0)),
    winRate: Number(row.trades || 0)
      ? Number(((Number(row.wins || 0) / Number(row.trades || 0)) * 100).toFixed(2))
      : 0,
    expectancy: Number(row.expectancy || 0),
    pnl: Number(row.pnl || 0)
  }));
}

async function getRecentRuns(db, { limit }) {
  try {
    const res = await db
      .prepare(`
        SELECT
          id,
          ran_at,
          timeframe,
          scanned_pairs,
          opened,
          closed,
          notes
        FROM paper_runs
        ORDER BY ran_at DESC
        LIMIT ${Number(limit || 10)}
      `)
      .all();

    return (res.results || []).map((row) => ({
      id: row.id,
      ranAt: row.ran_at,
      timeframe: row.timeframe,
      scannedPairs: Number(row.scanned_pairs || 0),
      opened: Number(row.opened || 0),
      closed: Number(row.closed || 0),
      notes: row.notes || ""
    }));
  } catch {
    return [];
  }
}

function computeLivePnlR(row) {
  const entry = Number(row.entry || 0);
  const current = Number(row.current_price || 0);
  const stop = Number(row.stop_loss || 0);
  const direction = String(row.direction || "buy").toLowerCase();
  const riskDistance = Math.abs(entry - stop);

  if (!entry || !current || !riskDistance) return 0;

  const pnlR =
    direction === "sell"
      ? (entry - current) / riskDistance
      : (current - entry) / riskDistance;

  return Number(pnlR.toFixed(3));
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
