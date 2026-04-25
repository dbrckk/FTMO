const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

const DEFAULT_PAIR = "EURUSD";
const DEFAULT_TIMEFRAME = "M15";
const DEFAULT_LIMIT = 220;
const MAX_LIMIT = 1000;

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

    const pair = normalizePair(url.searchParams.get("pair")) || DEFAULT_PAIR;
    const timeframe = normalizeTimeframe(url.searchParams.get("timeframe")) || DEFAULT_TIMEFRAME;
    const limit = normalizeLimit(url.searchParams.get("limit"));

    const candles = await getCandles(db, pair, timeframe, limit);
    const last = candles.at(-1) || null;

    return json({
      ok: true,
      source: "market-data",
      version: "market-data-btc-v2",
      pair,
      timeframe,
      limit,
      count: candles.length,
      last,
      candles
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "market-data-error")
    }, 500);
  }
}

async function getCandles(db, pair, timeframe, limit) {
  const res = await db
    .prepare(`
      SELECT
        ts,
        open,
        high,
        low,
        close
      FROM market_candles
      WHERE pair = ?
        AND timeframe = ?
      ORDER BY ts DESC
      LIMIT ?
    `)
    .bind(pair, timeframe, limit)
    .all();

  const rows = Array.isArray(res.results) ? res.results : [];

  return rows
    .map((row) => ({
      time: Number(row.ts || 0),
      ts: Number(row.ts || 0),
      open: roundByPair(row.open, pair),
      high: roundByPair(row.high, pair),
      low: roundByPair(row.low, pair),
      close: roundByPair(row.close, pair)
    }))
    .filter((candle) =>
      Number.isFinite(candle.time) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      candle.close > 0
    )
    .sort((a, b) => a.time - b.time);
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

function normalizeLimit(value) {
  const limit = Number(value || DEFAULT_LIMIT);

  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  if (limit < 20) return 20;
  if (limit > MAX_LIMIT) return MAX_LIMIT;

  return Math.round(limit);
}

function roundByPair(value, pair) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  if (pair === "XAUUSD") return Number(n.toFixed(2));
  if (pair === "BTCUSD") return Number(n.toFixed(2));
  if (pair.includes("JPY")) return Number(n.toFixed(3));

  return Number(n.toFixed(5));
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
