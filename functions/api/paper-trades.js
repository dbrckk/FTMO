const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

const DEFAULT_TIMEFRAME = "M15";

export async function onRequestGet(context) {
  try {
    const db = context.env?.DB;

    if (!db) {
      return json({
        ok: false,
        error: "Missing DB binding"
      }, 500);
    }

    const url = new URL(context.request.url);
    const timeframe = normalizeTimeframe(url.searchParams.get("timeframe")) || DEFAULT_TIMEFRAME;
    const pair = normalizePair(url.searchParams.get("pair"));
    const limit = normalizeLimit(url.searchParams.get("limit"), 50);

    const [open, recent, pairStats, summary, runs] = await Promise.all([
      getOpenTrades(db, timeframe, pair),
      getRecentClosedTrades(db, timeframe, pair, limit),
      getPairStats(db, timeframe),
      getSummary(db, timeframe),
      getRuns(db, timeframe)
    ]);

    return json({
      ok: true,
      source: "paper-trades",
      version: "paper-trades-btc-v3",
      timeframe,
      pair: pair || null,
      summary,
      open,
      recent,
      pairStats,
      runs
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "paper-trades-get-error")
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env?.DB;

    if (!db) {
      return json({
        ok: false,
        error: "Missing DB binding"
      }, 500);
    }

    const body = await safeJson(context.request);
    const trade = normalizeClosedTrade(body.trade || body);

    if (!trade) {
      return json({
        ok: false,
        error: "Invalid closed trade payload"
      }, 400);
    }

    await insertClosedTrade(db, trade);

    return json({
      ok: true,
      source: "paper-trades",
      version: "paper-trades-btc-v3",
      saved: true,
      trade
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "paper-trades-post-error")
    }, 500);
  }
}

async function getOpenTrades(db, timeframe, pair) {
  const where = pair
    ? `WHERE timeframe = ? AND pair = ?`
    : `WHERE timeframe = ?`;

  const bindValues = pair ? [timeframe, pair] : [timeframe];

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
      ${where}
      ORDER BY opened_at DESC
    `)
    .bind(...bindValues)
    .all();

  const rows = Array.isArray(res.results) ? res.results : [];

  return rows.map(normalizeOpenRow);
}

async function getRecentClosedTrades(db, timeframe, pair, limit) {
  const where = pair
    ? `WHERE timeframe = ? AND pair = ?`
    : `WHERE timeframe = ?`;

  const bindValues = pair ? [timeframe, pair, limit] : [timeframe, limit];

  const res = await db
    .prepare(`
      SELECT
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
      FROM paper_trades
      ${where}
      ORDER BY closed_at DESC
      LIMIT ?
    `)
    .bind(...bindValues)
    .all();

  const rows = Array.isArray(res.results) ? res.results : [];

  return rows.map(normalizeClosedRow);
}

async function getPairStats(db, timeframe) {
  const res = await db
    .prepare(`
      SELECT
        pair,
        COUNT(*) AS trades,
        SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
        ROUND(AVG(pnl_r), 4) AS expectancy,
        ROUND(SUM(pnl), 2) AS pnl
      FROM paper_trades
      WHERE timeframe = ?
      GROUP BY pair
      ORDER BY expectancy DESC, trades DESC
    `)
    .bind(timeframe)
    .all();

  const rows = Array.isArray(res.results) ? res.results : [];

  return rows.map((row) => {
    const trades = Number(row.trades || 0);
    const wins = Number(row.wins || 0);

    return {
      pair: String(row.pair || "").toUpperCase(),
      trades,
      wins,
      losses: Math.max(0, trades - wins),
      winRate: trades ? Number(((wins / trades) * 100).toFixed(2)) : 0,
      expectancy: Number(row.expectancy || 0),
      pnl: Number(row.pnl || 0)
    };
  });
}

async function getSummary(db, timeframe) {
  const row = await db
    .prepare(`
      SELECT
        COUNT(*) AS trades,
        SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
        ROUND(AVG(pnl_r), 4) AS expectancy,
        ROUND(SUM(pnl), 2) AS pnl
      FROM paper_trades
      WHERE timeframe = ?
    `)
    .bind(timeframe)
    .first();

  const trades = Number(row?.trades || 0);
  const wins = Number(row?.wins || 0);

  return {
    trades,
    wins,
    losses: Math.max(0, trades - wins),
    winRate: trades ? Number(((wins / trades) * 100).toFixed(2)) : 0,
    expectancy: Number(row?.expectancy || 0),
    pnl: Number(row?.pnl || 0)
  };
}

async function getRuns(db, timeframe) {
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
        WHERE timeframe = ?
        ORDER BY ran_at DESC
        LIMIT 20
      `)
      .bind(timeframe)
      .all();

    const rows = Array.isArray(res.results) ? res.results : [];

    return rows.map((row) => ({
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

async function insertClosedTrade(db, trade) {
  await db
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
      trade.ultraScore,
      trade.mlScore,
      trade.vectorbtScore,
      trade.archiveEdgeScore,
      trade.closeReason,
      trade.source
    )
    .run();
}

function normalizeOpenRow(row) {
  const pair = normalizePair(row.pair) || String(row.pair || "").toUpperCase();
  const entry = Number(row.entry || 0);
  const currentPrice = Number(row.current_price || entry);
  const stopLoss = Number(row.stop_loss || 0);
  const direction = String(row.direction || "buy").toLowerCase();

  return {
    id: row.id,
    pair,
    timeframe: normalizeTimeframe(row.timeframe) || DEFAULT_TIMEFRAME,
    direction,
    openedAt: row.opened_at,
    entry: roundByPair(entry, pair),
    stopLoss: roundByPair(stopLoss, pair),
    takeProfit: roundByPair(row.take_profit, pair),
    currentPrice: roundByPair(currentPrice, pair),
    riskPercent: Number(row.risk_percent || 0),
    rr: Number(row.rr || 0),
    barsHeld: Number(row.bars_held || 0),
    maxBarsHold: Number(row.max_bars_hold || 0),
    ultraScore: Number(row.ultra_score || 0),
    mlScore: Number(row.ml_score || 0),
    archiveEdgeScore: Number(row.archive_edge_score || 0),
    session: row.session || "OffSession",
    hour: Number(row.hour || 0),
    modelTag: row.model_tag || "",
    source: row.source || "server-paper",
    pnlRLive: computeLivePnlR({
      direction,
      entry,
      stopLoss,
      currentPrice
    })
  };
}

function normalizeClosedRow(row) {
  const pair = normalizePair(row.pair) || String(row.pair || "").toUpperCase();

  return {
    id: row.id,
    pair,
    timeframe: normalizeTimeframe(row.timeframe) || DEFAULT_TIMEFRAME,
    direction: String(row.direction || "buy").toLowerCase(),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    entry: roundByPair(row.entry, pair),
    exitPrice: roundByPair(row.exit, pair),
    stopLoss: roundByPair(row.stop_loss, pair),
    takeProfit: roundByPair(row.take_profit, pair),
    pnl: Number(row.pnl || 0),
    pnlR: Number(row.pnl_r || 0),
    win: Number(row.win || 0),
    session: row.session || "OffSession",
    hour: Number(row.hour || 0),
    ultraScore: Number(row.ultra_score || 0),
    mlScore: Number(row.ml_score || 0),
    vectorbtScore: Number(row.vectorbt_score || 0),
    archiveEdgeScore: Number(row.archive_edge_score || 0),
    closeReason: row.close_reason || "-",
    source: row.source || "paper"
  };
}

function normalizeClosedTrade(input) {
  const pair = normalizePair(input.pair);

  if (!pair) return null;

  const direction = String(input.direction || "").toLowerCase();

  if (!["buy", "sell"].includes(direction)) return null;

  const entry = Number(input.entry || 0);
  const exitPrice = Number(input.exitPrice ?? input.exit ?? 0);
  const stopLoss = Number(input.stopLoss ?? input.stop_loss ?? 0);
  const takeProfit = Number(input.takeProfit ?? input.take_profit ?? 0);
  const pnlR = Number(input.pnlR ?? input.pnl_r ?? 0);
  const pnl = Number(input.pnl ?? 0);

  return {
    id: String(input.id || `paper_${Date.now()}_${pair}_${Math.random().toString(36).slice(2, 8)}`),
    pair,
    timeframe: normalizeTimeframe(input.timeframe) || DEFAULT_TIMEFRAME,
    direction,
    openedAt: String(input.openedAt || input.opened_at || new Date().toISOString()),
    closedAt: String(input.closedAt || input.closed_at || new Date().toISOString()),
    entry: roundByPair(entry, pair),
    exitPrice: roundByPair(exitPrice, pair),
    stopLoss: roundByPair(stopLoss, pair),
    takeProfit: roundByPair(takeProfit, pair),
    pnl: round(pnl, 2),
    pnlR: round(pnlR, 3),
    win: Number(input.win ?? (pnlR > 0 ? 1 : 0)),
    session: String(input.session || inferSession(new Date())),
    hour: Number(input.hour || inferHour(new Date())),
    ultraScore: Number(input.ultraScore ?? input.ultra_score ?? 0),
    mlScore: Number(input.mlScore ?? input.ml_score ?? 50),
    vectorbtScore: Number(input.vectorbtScore ?? input.vectorbt_score ?? 50),
    archiveEdgeScore: Number(input.archiveEdgeScore ?? input.archive_edge_score ?? 50),
    closeReason: String(input.closeReason || input.close_reason || "unknown"),
    source: String(input.source || "browser-paper")
  };
}

function computeLivePnlR(trade) {
  const entry = Number(trade.entry || 0);
  const stopLoss = Number(trade.stopLoss || 0);
  const currentPrice = Number(trade.currentPrice || 0);
  const direction = String(trade.direction || "buy").toLowerCase();
  const risk = Math.abs(entry - stopLoss);

  if (!entry || !risk || !currentPrice) return 0;

  const pnlR =
    direction === "buy"
      ? (currentPrice - entry) / risk
      : (entry - currentPrice) / risk;

  return round(pnlR, 3);
}

function normalizePair(value) {
  const pair = String(value || "")
    .toUpperCase()
    .replace("/", "")
    .trim();

  if (!pair) return "";

  return PAIRS.includes(pair) ? pair : "";
}

function normalizeTimeframe(value) {
  const timeframe = String(value || "")
    .toUpperCase()
    .trim();

  return ["M5", "M15", "H1", "H4"].includes(timeframe) ? timeframe : "";
}

function normalizeLimit(value, fallback = 50) {
  const n = Number(value || fallback);

  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return 1;
  if (n > 300) return 300;

  return Math.round(n);
}

function inferSession(date = new Date()) {
  const hour = inferHour(date);

  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const tokyo = hour >= 1 && hour < 10;

  if (london && newYork) return "London+NewYork";
  if (london) return "London";
  if (newYork) return "NewYork";
  if (tokyo) return "Tokyo";

  return "OffSession";
}

function inferHour(date = new Date()) {
  return Number(
    new Date(date).toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );
}

function roundByPair(value, pair) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  if (pair === "XAUUSD" || pair === "BTCUSD") return Number(n.toFixed(2));
  if (String(pair).includes("JPY")) return Number(n.toFixed(3));

  return Number(n.toFixed(5));
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Number(n.toFixed(digits));
}

async function safeJson(request) {
  try {
    const contentType = request.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("application/json")) {
      return {};
    }

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
