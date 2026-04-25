const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

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
    const timeframe = normalizeTimeframe(url.searchParams.get("timeframe")) || "M15";
    const pair = String(url.searchParams.get("pair") || "").toUpperCase().trim();

    if (pair) {
      const rows = await getRows(db, timeframe, pair);
      const stats = buildStats(rows);

      return json({
        ok: true,
        source: "archive-stats",
        version: "archive-stats-btc-v2",
        timeframe,
        pair,
        stats
      });
    }

    const stats = {};

    for (const item of PAIRS) {
      const rows = await getRows(db, timeframe, item);
      stats[item] = buildStats(rows);
    }

    return json({
      ok: true,
      source: "archive-stats",
      version: "archive-stats-btc-v2",
      timeframe,
      totalPairs: PAIRS.length,
      stats
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "archive-stats-error")
    }, 500);
  }
}

async function getRows(db, timeframe, pair) {
  const res = await db
    .prepare(`
      SELECT
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
      WHERE timeframe = ?
        AND pair = ?
      ORDER BY closed_at DESC
      LIMIT 1200
    `)
    .bind(timeframe, pair)
    .all();

  return Array.isArray(res.results) ? res.results : [];
}

function buildStats(rows) {
  const trades = rows.map(normalizeTrade).filter(Boolean);

  const all = packStats(trades);
  const buy = packStats(trades.filter((trade) => trade.direction === "buy"));
  const sell = packStats(trades.filter((trade) => trade.direction === "sell"));

  const last20 = packStats(trades.slice(0, 20));
  const last50 = packStats(trades.slice(0, 50));

  const sessions = groupAndPack(trades, "session");
  const hours = groupAndPack(trades, "hour");
  const closeReasons = groupAndPack(trades, "closeReason");

  const bestSession = pickBestGroup(sessions);
  const bestHour = pickBestGroup(hours);
  const worstSession = pickWorstGroup(sessions);
  const worstHour = pickWorstGroup(hours);

  const archiveConfidence = computeConfidence(trades.length);
  const edgeScore = computeEdgeScore({
    expectancy: all.expectancy,
    winRate: all.winRate,
    last20Expectancy: last20.expectancy,
    last20WinRate: last20.winRate,
    trades: trades.length
  });

  return {
    pairTradesCount: trades.length,
    archiveConfidence,

    pairWinRate: all.winRate,
    pairExpectancy: all.expectancy,
    pairProfitFactor: all.profitFactor,
    pairPnlR: all.pnlR,
    pairPnl: all.pnl,

    last20WinRate: last20.winRate,
    last20Expectancy: last20.expectancy,
    last50WinRate: last50.winRate,
    last50Expectancy: last50.expectancy,

    edgeScore,

    directions: {
      buy,
      sell
    },

    sessions,
    hours,
    closeReasons,

    bestSession,
    bestHour,
    worstSession,
    worstHour,

    recent: trades.slice(0, 20)
  };
}

function normalizeTrade(row) {
  const pair = String(row.pair || "").toUpperCase();
  const direction = String(row.direction || "").toLowerCase();

  if (!pair || !["buy", "sell"].includes(direction)) return null;

  const pnlR = Number(row.pnl_r || 0);
  const pnl = Number(row.pnl || 0);

  return {
    pair,
    timeframe: String(row.timeframe || "M15").toUpperCase(),
    direction,
    openedAt: row.opened_at || "",
    closedAt: row.closed_at || "",
    entry: Number(row.entry || 0),
    exit: Number(row.exit || 0),
    stopLoss: Number(row.stop_loss || 0),
    takeProfit: Number(row.take_profit || 0),
    pnl,
    pnlR,
    win: Number(row.win || 0) === 1 || pnlR > 0,
    session: String(row.session || "OffSession"),
    hour: String(Number(row.hour || 0)),
    ultraScore: Number(row.ultra_score || 0),
    mlScore: Number(row.ml_score || 0),
    vectorbtScore: Number(row.vectorbt_score || 0),
    archiveEdgeScore: Number(row.archive_edge_score || 0),
    closeReason: String(row.close_reason || "unknown"),
    source: String(row.source || "unknown")
  };
}

function packStats(trades) {
  const count = trades.length;

  if (!count) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 50,
      expectancy: 0,
      pnlR: 0,
      pnl: 0,
      averageWinR: 0,
      averageLossR: 0,
      profitFactor: 0,
      maxWinR: 0,
      maxLossR: 0
    };
  }

  const wins = trades.filter((trade) => trade.win || Number(trade.pnlR || 0) > 0);
  const losses = trades.filter((trade) => !trade.win && Number(trade.pnlR || 0) <= 0);

  const pnlR = trades.reduce((sum, trade) => sum + Number(trade.pnlR || 0), 0);
  const pnl = trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);

  const grossWinR = wins.reduce((sum, trade) => sum + Math.max(0, Number(trade.pnlR || 0)), 0);
  const grossLossR = Math.abs(losses.reduce((sum, trade) => sum + Math.min(0, Number(trade.pnlR || 0)), 0));

  const averageWinR = wins.length
    ? grossWinR / wins.length
    : 0;

  const averageLossR = losses.length
    ? grossLossR / losses.length
    : 0;

  const maxWinR = trades.reduce((max, trade) => Math.max(max, Number(trade.pnlR || 0)), -999);
  const maxLossR = trades.reduce((min, trade) => Math.min(min, Number(trade.pnlR || 0)), 999);

  return {
    trades: count,
    wins: wins.length,
    losses: losses.length,
    winRate: Number(((wins.length / count) * 100).toFixed(2)),
    expectancy: Number((pnlR / count).toFixed(4)),
    pnlR: Number(pnlR.toFixed(3)),
    pnl: Number(pnl.toFixed(2)),
    averageWinR: Number(averageWinR.toFixed(3)),
    averageLossR: Number(averageLossR.toFixed(3)),
    profitFactor: grossLossR > 0
      ? Number((grossWinR / grossLossR).toFixed(3))
      : grossWinR > 0
        ? 99
        : 0,
    maxWinR: Number(maxWinR.toFixed(3)),
    maxLossR: Number(maxLossR.toFixed(3))
  };
}

function groupAndPack(trades, key) {
  const groups = {};

  for (const trade of trades) {
    const value = String(trade[key] ?? "unknown");

    if (!groups[value]) {
      groups[value] = [];
    }

    groups[value].push(trade);
  }

  return Object.fromEntries(
    Object.entries(groups).map(([group, groupTrades]) => [
      group,
      packStats(groupTrades)
    ])
  );
}

function pickBestGroup(groups) {
  const rows = Object.entries(groups || {})
    .map(([key, stats]) => ({
      key,
      ...stats
    }))
    .filter((row) => Number(row.trades || 0) >= 3)
    .sort((a, b) => {
      if (Number(b.expectancy || 0) !== Number(a.expectancy || 0)) {
        return Number(b.expectancy || 0) - Number(a.expectancy || 0);
      }

      return Number(b.winRate || 0) - Number(a.winRate || 0);
    });

  return rows[0] || null;
}

function pickWorstGroup(groups) {
  const rows = Object.entries(groups || {})
    .map(([key, stats]) => ({
      key,
      ...stats
    }))
    .filter((row) => Number(row.trades || 0) >= 3)
    .sort((a, b) => {
      if (Number(a.expectancy || 0) !== Number(b.expectancy || 0)) {
        return Number(a.expectancy || 0) - Number(b.expectancy || 0);
      }

      return Number(a.winRate || 0) - Number(b.winRate || 0);
    });

  return rows[0] || null;
}

function computeConfidence(tradesCount) {
  const count = Number(tradesCount || 0);

  if (count >= 80) return 99;
  if (count >= 50) return 90;
  if (count >= 30) return 78;
  if (count >= 15) return 62;
  if (count >= 8) return 45;
  if (count >= 3) return 28;

  return Math.max(0, count * 8);
}

function computeEdgeScore(data) {
  const trades = Number(data.trades || 0);
  const confidence = computeConfidence(trades) / 100;

  const expectancyScore = clamp(50 + Number(data.expectancy || 0) * 42, 1, 99);
  const winRateScore = clamp(50 + (Number(data.winRate || 50) - 50) * 1.35, 1, 99);
  const recentExpectancyScore = clamp(50 + Number(data.last20Expectancy || 0) * 38, 1, 99);
  const recentWinRateScore = clamp(50 + (Number(data.last20WinRate || 50) - 50) * 1.15, 1, 99);

  const raw =
    expectancyScore * 0.34 +
    winRateScore * 0.24 +
    recentExpectancyScore * 0.25 +
    recentWinRateScore * 0.17;

  return Math.round(50 + (raw - 50) * confidence);
}

function normalizeTimeframe(value) {
  const tf = String(value || "").toUpperCase().trim();
  return ["M5", "M15", "H1", "H4"].includes(tf) ? tf : "";
}

function clamp(value, min = 1, max = 99) {
  const n = Number(value);

  if (!Number.isFinite(n)) return min;

  return Math.max(min, Math.min(max, n));
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
