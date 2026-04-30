const MODEL_VERSION = "reset-paper-guard-v1";

export async function onRequestGet(context) {
  return handleResetPaperGuard(context);
}

export async function onRequestPost(context) {
  return handleResetPaperGuard(context);
}

async function handleResetPaperGuard(context) {
  try {
    const env = context.env || {};
    const db = env.DB;

    if (!db) {
      return json({
        ok: false,
        source: "reset-paper-guard",
        version: MODEL_VERSION,
        error: "Missing DB binding"
      }, 500);
    }

    if (!isAuthorized(context.request, env.SYNC_SECRET || "")) {
      return json({
        ok: false,
        source: "reset-paper-guard",
        version: MODEL_VERSION,
        error: "Unauthorized"
      }, 401);
    }

    await ensureResetTables(db);

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    const hard = readBool(url, body, "hard", false);
    const resetAlerts = readBool(url, body, "resetAlerts", true);
    const resetOpenTrades = readBool(url, body, "resetOpenTrades", false);
    const maxRows = Number(url.searchParams.get("maxRows") || body.maxRows || 20);
    const reason = String(url.searchParams.get("reason") || body.reason || "manual-paper-guard-reset");

    const recentTrades = await getRecentPaperTrades(db, maxRows);
    const consecutiveLosses = getConsecutiveLosses(recentTrades);

    let archived = 0;
    let deleted = 0;
    let openTradesDeleted = 0;
    let alertCooldownsDeleted = 0;

    const resetId = `paper_guard_reset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (hard && consecutiveLosses.length > 0) {
      for (const trade of consecutiveLosses) {
        await archiveTrade(db, resetId, trade);
        archived += 1;
      }

      for (const trade of consecutiveLosses) {
        await db.prepare(`
          DELETE FROM paper_trades
          WHERE id = ?
        `).bind(trade.id).run();

        deleted += 1;
      }
    }

    if (resetOpenTrades) {
      try {
        const res = await db.prepare(`
          DELETE FROM paper_open_trades
        `).run();

        openTradesDeleted = Number(res.meta?.changes || 0);
      } catch {
        openTradesDeleted = 0;
      }
    }

    if (resetAlerts) {
      try {
        const res = await db.prepare(`
          DELETE FROM alert_cooldowns
        `).run();

        alertCooldownsDeleted = Number(res.meta?.changes || 0);
      } catch {
        alertCooldownsDeleted = 0;
      }
    }

    await db.prepare(`
      INSERT INTO paper_guard_resets (
        id,
        created_at,
        hard_reset,
        reason,
        consecutive_losses_found,
        trades_archived,
        trades_deleted,
        open_trades_deleted,
        alert_cooldowns_deleted,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      resetId,
      new Date().toISOString(),
      hard ? 1 : 0,
      reason,
      consecutiveLosses.length,
      archived,
      deleted,
      openTradesDeleted,
      alertCooldownsDeleted,
      JSON.stringify({
        recentTrades: recentTrades.map(publicTrade),
        consecutiveLosses: consecutiveLosses.map(publicTrade)
      })
    ).run();

    return json({
      ok: true,
      source: "reset-paper-guard",
      version: MODEL_VERSION,
      resetId,
      mode: hard ? "hard" : "soft",
      reason,
      consecutiveLossesFound: consecutiveLosses.length,
      tradesArchived: archived,
      tradesDeleted: deleted,
      openTradesDeleted,
      alertCooldownsDeleted,
      message: hard
        ? "Paper guard hard reset completed. Recent consecutive paper losses were archived and removed from active paper history."
        : "Soft reset completed. No paper trades were deleted. Use hard=1 to remove recent consecutive paper losses.",
      nextTestUrl: "/api/server-trading?timeframes=M15&dryRun=0&sync=1&health=1&paper=1&alerts=1&analytics=1&telegram=1"
    });
  } catch (error) {
    return json({
      ok: false,
      source: "reset-paper-guard",
      version: MODEL_VERSION,
      error: String(error?.message || error || "reset-paper-guard-error")
    }, 500);
  }
}

async function ensureResetTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS paper_guard_resets (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      hard_reset INTEGER,
      reason TEXT,
      consecutive_losses_found INTEGER,
      trades_archived INTEGER,
      trades_deleted INTEGER,
      open_trades_deleted INTEGER,
      alert_cooldowns_deleted INTEGER,
      payload_json TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS paper_guard_archived_trades (
      id TEXT PRIMARY KEY,
      reset_id TEXT,
      archived_at TEXT NOT NULL,
      trade_id TEXT,
      payload_json TEXT
    )
  `).run();
}

async function getRecentPaperTrades(db, maxRows) {
  try {
    const res = await db.prepare(`
      SELECT *
      FROM paper_trades
      ORDER BY COALESCE(closed_at, opened_at) DESC
      LIMIT ?
    `).bind(Math.max(1, Math.min(Number(maxRows || 20), 100))).all();

    return Array.isArray(res.results) ? res.results : [];
  } catch {
    return [];
  }
}

function getConsecutiveLosses(trades) {
  const losses = [];

  for (const trade of trades || []) {
    const win = Number(trade.win || 0);
    const pnlR = Number(trade.pnl_r || 0);
    const pnl = Number(trade.pnl || 0);

    const isLoss = win !== 1 && (pnlR < 0 || pnl < 0);

    if (!isLoss) {
      break;
    }

    losses.push(trade);
  }

  return losses;
}

async function archiveTrade(db, resetId, trade) {
  await db.prepare(`
    INSERT OR REPLACE INTO paper_guard_archived_trades (
      id,
      reset_id,
      archived_at,
      trade_id,
      payload_json
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    `archived_${resetId}_${trade.id}`,
    resetId,
    new Date().toISOString(),
    trade.id,
    JSON.stringify(trade)
  ).run();
}

function publicTrade(trade) {
  return {
    id: trade.id,
    pair: trade.pair,
    timeframe: trade.timeframe,
    direction: trade.direction,
    openedAt: trade.opened_at,
    closedAt: trade.closed_at,
    pnl: trade.pnl,
    pnlR: trade.pnl_r,
    win: trade.win,
    source: trade.source,
    closeReason: trade.close_reason
  };
}

function readBool(url, body, key, fallback = false) {
  const queryValue = url.searchParams.get(key);

  if (queryValue !== null && queryValue !== undefined && queryValue !== "") {
    return queryValue === "1" || queryValue.toLowerCase() === "true";
  }

  const bodyValue = body?.[key];

  if (bodyValue !== null && bodyValue !== undefined && bodyValue !== "") {
    if (typeof bodyValue === "boolean") return bodyValue;
    return String(bodyValue) === "1" || String(bodyValue).toLowerCase() === "true";
  }

  return fallback;
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

function isAuthorized(request, secret) {
  if (!secret) return true;

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  return token === secret || bearer === secret;
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
