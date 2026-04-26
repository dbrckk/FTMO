import {
  buildArchiveIntelligence,
  getArchiveStatsMap,
  ensureArchiveColumns
} from "../_shared/archive-intelligence.js";

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

    await ensureArchiveColumns(db);

    const url = new URL(context.request.url);

    const pair = normalizePair(url.searchParams.get("pair"));
    const timeframe = normalizeTimeframe(url.searchParams.get("timeframe")) || "M15";
    const direction = normalizeDirection(url.searchParams.get("direction"));
    const setupType = cleanText(url.searchParams.get("setupType"));
    const session = cleanText(url.searchParams.get("session"));
    const hourRaw = url.searchParams.get("hour");
    const hour = hourRaw === null ? null : Number(hourRaw);

    if (pair) {
      const intelligence = await buildArchiveIntelligence(db, {
        pair,
        timeframe,
        direction,
        setupType,
        session,
        hour: Number.isFinite(hour) ? hour : undefined
      });

      return json({
        ok: true,
        source: "archive-stats-v7",
        pair,
        timeframe,
        direction: direction || null,
        setupType: setupType || null,
        session: session || null,
        hour: Number.isFinite(hour) ? hour : null,

        archiveEdgeScore: intelligence.edgeScore,
        archiveConfidence: intelligence.confidence,

        core: intelligence.core,
        directionStats: intelligence.direction,
        setupStats: intelligence.setup,
        sessionStats: intelligence.session,
        hourStats: intelligence.hour,

        byDirection: intelligence.byDirection,
        bySetup: intelligence.bySetup,
        bySession: intelligence.bySession,
        byHour: intelligence.byHour,

        bestDirection: intelligence.bestDirection,
        bestSetup: intelligence.bestSetup,
        bestSession: intelligence.bestSession,
        bestHour: intelligence.bestHour,

        stats: {
          [pair]: {
            pairTradesCount: intelligence.core.trades,
            trades: intelligence.core.trades,
            wins: intelligence.core.wins,
            pairWinRate: intelligence.core.winRate,
            winRate: intelligence.core.winRate,
            pairExpectancy: intelligence.core.expectancy,
            expectancy: intelligence.core.expectancy,
            pairPnlR: intelligence.core.pnlR,
            pnlR: intelligence.core.pnlR,
            archiveEdgeScore: intelligence.edgeScore,
            archiveConfidence: intelligence.confidence,
            directions: normalizeDirections(intelligence.byDirection),
            bestDirection: intelligence.bestDirection,
            bestSetup: intelligence.bestSetup,
            bestSession: intelligence.bestSession,
            bestHour: intelligence.bestHour,
            byDirection: intelligence.byDirection,
            bySetup: intelligence.bySetup,
            bySession: intelligence.bySession,
            byHour: intelligence.byHour
          }
        }
      });
    }

    const stats = await getArchiveStatsMap(db, timeframe, PAIRS);

    return json({
      ok: true,
      source: "archive-stats-v7",
      timeframe,
      pair: null,
      stats,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    return json({
      ok: false,
      source: "archive-stats-v7",
      error: String(error?.message || error || "archive-stats-error")
    }, 500);
  }
}

function normalizeDirections(rows) {
  const directions = {};

  for (const row of rows || []) {
    directions[String(row.key || "").toLowerCase()] = {
      trades: row.trades,
      wins: row.wins,
      winRate: row.winRate,
      expectancy: row.expectancy,
      pnlR: row.pnlR
    };
  }

  return directions;
}

function normalizePair(value) {
  const pair = String(value || "").toUpperCase().replace("/", "").trim();

  return PAIRS.includes(pair) ? pair : "";
}

function normalizeTimeframe(value) {
  const timeframe = String(value || "").toUpperCase().trim();

  return ["M5", "M15", "H1", "H4"].includes(timeframe) ? timeframe : "";
}

function normalizeDirection(value) {
  const direction = String(value || "").toLowerCase().trim();

  return ["buy", "sell"].includes(direction) ? direction : "";
}

function cleanText(value) {
  return String(value || "").trim();
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
