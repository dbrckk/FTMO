const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

const MAX_CANDLE_AGE_SECONDS = {
  M5: 60 * 60,
  M15: 3 * 60 * 60,
  H1: 8 * 60 * 60,
  H4: 24 * 60 * 60
};

export async function onRequestGet(context) {
  try {
    const env = context.env || {};
    const db = env.DB;

    if (!db) {
      return json({
        ok: false,
        healthy: false,
        status: "DB_MISSING",
        error: "Missing DB binding"
      }, 500);
    }

    const url = new URL(context.request.url);
    const timeframe = normalizeTimeframe(url.searchParams.get("timeframe")) || "M15";

    const market = await getMarketHealth(db, timeframe);
    const openTrades = await getOpenTradesCount(db, timeframe);
    const closedSummary = await getClosedSummary(db, timeframe);
    const lastRun = await getLastRun(db, timeframe);

    const freshPairs = market.filter((row) => row.fresh).length;
    const stalePairs = market.filter((row) => !row.fresh && row.rows > 0).length;
    const missingPairs = market.filter((row) => row.rows === 0).length;

    const healthy =
      freshPairs >= 21 &&
      missingPairs === 0 &&
      Boolean(lastRun);

    const status =
      healthy ? "HEALTHY" :
      freshPairs >= 16 ? "WARNING" :
      "UNHEALTHY";

    return json({
      ok: true,
      healthy,
      status,
      timeframe,
      market: {
        totalPairs: PAIRS.length,
        freshPairs,
        stalePairs,
        missingPairs,
        maxAgeAllowedMinutes: Math.round((MAX_CANDLE_AGE_SECONDS[timeframe] || MAX_CANDLE_AGE_SECONDS.M15) / 60),
        pairs: market
      },
      paper: {
        openTrades,
        closedTrades: closedSummary.trades,
        winRate: closedSummary.winRate,
        expectancy: closedSummary.expectancy,
        pnl: closedSummary.pnl,
        lastRun
      }
    });
  } catch (error) {
    return json({
      ok: false,
      healthy: false,
      status: "ERROR",
      error: String(error?.message || error || "paper-health-error")
    }, 500);
  }
}

async function getMarketHealth(db, timeframe) {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = MAX_CANDLE_AGE_SECONDS[timeframe] || MAX_CANDLE_AGE_SECONDS.M15;

  const out = [];

  for (const pair of PAIRS) {
    const row = await db
      .prepare(`
        SELECT
          COUNT(*) AS rows,
          MAX(ts) AS last_ts
        FROM market_candles
        WHERE pair = ? AND timeframe = ?
      `)
      .bind(pair, timeframe)
      .first();

    const rows = Number(row?.rows || 0);
    const lastTs = Number(row?.last_ts || 0);
    const ageSeconds = lastTs ? Math.max(0, now - lastTs) : 999999999;
    const ageMinutes = Math.round(ageSeconds / 60);
    const fresh = rows >= 40 && ageSeconds <= maxAge;

    out.push({
      pair,
      rows,
      lastTs,
      ageMinutes,
      fresh,
      status: rows === 0 ? "MISSING" : fresh ? "FRESH" : "STALE"
    });
  }

  return out;
}

async function getOpenTradesCount(db, timeframe) {
  try {
    const row = await db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM paper_open_trades
        WHERE timeframe = ?
      `)
      .bind(timeframe)
      .first();

    return Number(row?.count || 0);
  } catch {
    return 0;
  }
}

async function getClosedSummary(db, timeframe) {
  try {
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
  } catch {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      expectancy: 0,
      pnl: 0
    };
  }
}

async function getLastRun(db, timeframe) {
  try {
    const row = await db
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
        LIMIT 1
      `)
      .bind(timeframe)
      .first();

    if (!row) return null;

    return {
      id: row.id,
      ranAt: row.ran_at,
      timeframe: row.timeframe,
      scannedPairs: Number(row.scanned_pairs || 0),
      opened: Number(row.opened || 0),
      closed: Number(row.closed || 0),
      notes: row.notes || ""
    };
  } catch {
    return null;
  }
}

function normalizeTimeframe(value) {
  const tf = String(value || "").toUpperCase().trim();
  return ["M5", "M15", "H1", "H4"].includes(tf) ? tf : "";
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
