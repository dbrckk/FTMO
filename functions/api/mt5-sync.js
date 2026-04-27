const MODEL_VERSION = "mt5-sync-v1";

export async function onRequestGet(context) {
  return handleMt5Sync(context);
}

export async function onRequestPost(context) {
  return handleMt5Sync(context);
}

async function handleMt5Sync(context) {
  try {
    const env = context.env || {};
    const db = env.DB;

    if (!db) {
      return json({
        ok: false,
        source: "mt5-sync",
        version: MODEL_VERSION,
        error: "Missing DB binding"
      }, 500);
    }

    if (!isAuthorized(context.request, env.SYNC_SECRET || "")) {
      return json({
        ok: false,
        source: "mt5-sync",
        version: MODEL_VERSION,
        error: "Unauthorized"
      }, 401);
    }

    await ensureMt5Tables(db);

    if (context.request.method === "GET") {
      const url = new URL(context.request.url);
      const accountId = String(url.searchParams.get("accountId") || "").trim();

      const summary = await getMt5Summary(db, accountId);

      return json({
        ok: true,
        source: "mt5-sync",
        version: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        ...summary
      });
    }

    const body = await safeJson(context.request);

    const account = normalizeAccount(body.account || body);
    const deals = Array.isArray(body.deals) ? body.deals : [];
    const positions = Array.isArray(body.positions) ? body.positions : [];

    if (!account.accountId) {
      return json({
        ok: false,
        source: "mt5-sync",
        version: MODEL_VERSION,
        error: "Missing accountId/login"
      }, 400);
    }

    await upsertAccount(db, account);

    let insertedDeals = 0;
    let insertedPositions = 0;
    let learningRows = 0;

    for (const rawDeal of deals) {
      const deal = normalizeDeal(rawDeal, account);

      if (!deal.id) continue;

      const inserted = await upsertDeal(db, deal);

      if (inserted) insertedDeals += 1;

      const learned = await upsertLearningTradeFromDeal(db, deal, account);

      if (learned) learningRows += 1;
    }

    await clearPositionsForAccount(db, account.accountId);

    for (const rawPosition of positions) {
      const position = normalizePosition(rawPosition, account);

      if (!position.id) continue;

      await upsertPosition(db, position);
      insertedPositions += 1;
    }

    const summary = await getMt5Summary(db, account.accountId);

    return json({
      ok: true,
      source: "mt5-sync",
      version: MODEL_VERSION,
      receivedAt: new Date().toISOString(),
      accountId: account.accountId,
      dealsReceived: deals.length,
      dealsInsertedOrUpdated: insertedDeals,
      positionsReceived: positions.length,
      positionsInserted: insertedPositions,
      learningRows,
      summary
    });
  } catch (error) {
    return json({
      ok: false,
      source: "mt5-sync",
      version: MODEL_VERSION,
      error: String(error?.message || error || "mt5-sync-error")
    }, 500);
  }
}

async function ensureMt5Tables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS mt5_accounts (
      account_id TEXT PRIMARY KEY,
      login TEXT,
      company TEXT,
      server TEXT,
      currency TEXT,
      name TEXT,
      leverage INTEGER,
      balance REAL,
      equity REAL,
      margin REAL,
      free_margin REAL,
      margin_level REAL,
      profit REAL,
      last_sync_at TEXT,
      raw_json TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS mt5_deals (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      deal_ticket TEXT,
      order_ticket TEXT,
      position_id TEXT,
      symbol TEXT,
      side TEXT,
      entry_type TEXT,
      volume REAL,
      price REAL,
      profit REAL,
      commission REAL,
      swap REAL,
      fee REAL,
      net_profit REAL,
      magic INTEGER,
      comment TEXT,
      deal_time TEXT,
      created_at TEXT,
      raw_json TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS mt5_positions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      position_id TEXT,
      symbol TEXT,
      side TEXT,
      volume REAL,
      open_price REAL,
      current_price REAL,
      sl REAL,
      tp REAL,
      profit REAL,
      swap REAL,
      magic INTEGER,
      comment TEXT,
      opened_at TEXT,
      updated_at TEXT,
      raw_json TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS learning_trades (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      account_id TEXT,
      pair TEXT,
      timeframe TEXT,
      direction TEXT,
      opened_at TEXT,
      closed_at TEXT,
      entry REAL,
      exit REAL,
      volume REAL,
      pnl REAL,
      pnl_r REAL,
      win INTEGER,
      setup_type TEXT,
      session TEXT,
      hour INTEGER,
      score REAL,
      entry_quality_score REAL,
      exit_pressure_score REAL,
      archive_edge_score REAL,
      notes TEXT,
      raw_json TEXT,
      created_at TEXT
    )
  `).run();

  await addColumnIfMissing(db, "learning_trades", "source", "TEXT");
  await addColumnIfMissing(db, "learning_trades", "source_id", "TEXT");
  await addColumnIfMissing(db, "learning_trades", "account_id", "TEXT");
  await addColumnIfMissing(db, "learning_trades", "pair", "TEXT");
  await addColumnIfMissing(db, "learning_trades", "timeframe", "TEXT");
  await addColumnIfMissing(db, "learning_trades", "direction", "TEXT");
  await addColumnIfMissing(db, "learning_trades", "pnl_r", "REAL");
  await addColumnIfMissing(db, "learning_trades", "win", "INTEGER");
  await addColumnIfMissing(db, "learning_trades", "setup_type", "TEXT");
  await addColumnIfMissing(db, "learning_trades", "session", "TEXT");
  await addColumnIfMissing(db, "learning_trades", "hour", "INTEGER");
}

async function addColumnIfMissing(db, table, column, type) {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch {
    // Column already exists.
  }
}

function normalizeAccount(raw = {}) {
  const login = String(raw.login || raw.accountLogin || raw.account || "").trim();

  return {
    accountId: String(raw.accountId || raw.account_id || login).trim(),
    login,
    company: String(raw.company || "").trim(),
    server: String(raw.server || "").trim(),
    currency: String(raw.currency || "USD").trim(),
    name: String(raw.name || "").trim(),
    leverage: Number(raw.leverage || 0),
    balance: Number(raw.balance || 0),
    equity: Number(raw.equity || 0),
    margin: Number(raw.margin || 0),
    freeMargin: Number(raw.freeMargin || raw.free_margin || 0),
    marginLevel: Number(raw.marginLevel || raw.margin_level || 0),
    profit: Number(raw.profit || 0),
    raw
  };
}

function normalizeDeal(raw = {}, account = {}) {
  const ticket = String(raw.ticket || raw.dealTicket || raw.deal_ticket || "").trim();
  const accountId = String(account.accountId || raw.accountId || raw.account_id || "").trim();

  const profit = Number(raw.profit || 0);
  const commission = Number(raw.commission || 0);
  const swap = Number(raw.swap || 0);
  const fee = Number(raw.fee || 0);
  const netProfit = profit + commission + swap + fee;

  const symbol = normalizeSymbol(raw.symbol || raw.pair || "");
  const side = normalizeSide(raw.side || raw.type || raw.dealType || raw.deal_type || "");
  const entryType = normalizeEntryType(raw.entryType || raw.entry_type || raw.entry || "");

  return {
    id: `${accountId}_${ticket}`,
    accountId,
    ticket,
    orderTicket: String(raw.orderTicket || raw.order_ticket || raw.order || "").trim(),
    positionId: String(raw.positionId || raw.position_id || raw.position || "").trim(),
    symbol,
    side,
    entryType,
    volume: Number(raw.volume || 0),
    price: Number(raw.price || 0),
    profit,
    commission,
    swap,
    fee,
    netProfit,
    magic: Number(raw.magic || 0),
    comment: String(raw.comment || "").trim(),
    dealTime: normalizeIsoDate(raw.time || raw.dealTime || raw.deal_time || raw.createdAt || raw.created_at),
    raw
  };
}

function normalizePosition(raw = {}, account = {}) {
  const accountId = String(account.accountId || raw.accountId || raw.account_id || "").trim();
  const positionId = String(raw.positionId || raw.position_id || raw.ticket || "").trim();

  return {
    id: `${accountId}_${positionId}`,
    accountId,
    positionId,
    symbol: normalizeSymbol(raw.symbol || raw.pair || ""),
    side: normalizeSide(raw.side || raw.type || ""),
    volume: Number(raw.volume || 0),
    openPrice: Number(raw.openPrice || raw.open_price || raw.priceOpen || raw.price_open || 0),
    currentPrice: Number(raw.currentPrice || raw.current_price || raw.priceCurrent || raw.price_current || 0),
    sl: Number(raw.sl || raw.stopLoss || raw.stop_loss || 0),
    tp: Number(raw.tp || raw.takeProfit || raw.take_profit || 0),
    profit: Number(raw.profit || 0),
    swap: Number(raw.swap || 0),
    magic: Number(raw.magic || 0),
    comment: String(raw.comment || "").trim(),
    openedAt: normalizeIsoDate(raw.openedAt || raw.opened_at || raw.time || raw.timeOpen || raw.time_open),
    raw
  };
}

async function upsertAccount(db, account) {
  await db.prepare(`
    INSERT OR REPLACE INTO mt5_accounts (
      account_id,
      login,
      company,
      server,
      currency,
      name,
      leverage,
      balance,
      equity,
      margin,
      free_margin,
      margin_level,
      profit,
      last_sync_at,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    account.accountId,
    account.login,
    account.company,
    account.server,
    account.currency,
    account.name,
    account.leverage,
    account.balance,
    account.equity,
    account.margin,
    account.freeMargin,
    account.marginLevel,
    account.profit,
    new Date().toISOString(),
    JSON.stringify(account.raw || {})
  ).run();
}

async function upsertDeal(db, deal) {
  await db.prepare(`
    INSERT OR REPLACE INTO mt5_deals (
      id,
      account_id,
      deal_ticket,
      order_ticket,
      position_id,
      symbol,
      side,
      entry_type,
      volume,
      price,
      profit,
      commission,
      swap,
      fee,
      net_profit,
      magic,
      comment,
      deal_time,
      created_at,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    deal.id,
    deal.accountId,
    deal.ticket,
    deal.orderTicket,
    deal.positionId,
    deal.symbol,
    deal.side,
    deal.entryType,
    deal.volume,
    deal.price,
    deal.profit,
    deal.commission,
    deal.swap,
    deal.fee,
    deal.netProfit,
    deal.magic,
    deal.comment,
    deal.dealTime,
    new Date().toISOString(),
    JSON.stringify(deal.raw || {})
  ).run();

  return true;
}

async function upsertLearningTradeFromDeal(db, deal, account) {
  if (!deal.ticket) return false;

  const entryType = String(deal.entryType || "").toLowerCase();

  if (!["out", "inout", "out_by", "closed"].includes(entryType)) {
    return false;
  }

  const pnl = Number(deal.netProfit || deal.profit || 0);

  await db.prepare(`
    INSERT OR REPLACE INTO learning_trades (
      id,
      source,
      source_id,
      account_id,
      pair,
      timeframe,
      direction,
      opened_at,
      closed_at,
      entry,
      exit,
      volume,
      pnl,
      pnl_r,
      win,
      setup_type,
      session,
      hour,
      score,
      entry_quality_score,
      exit_pressure_score,
      archive_edge_score,
      notes,
      raw_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    `mt5_${deal.id}`,
    "mt5",
    deal.id,
    account.accountId,
    deal.symbol,
    "MT5",
    deal.side,
    null,
    deal.dealTime,
    0,
    deal.price,
    deal.volume,
    pnl,
    0,
    pnl > 0 ? 1 : 0,
    inferSetupTypeFromComment(deal.comment),
    inferSessionFromIso(deal.dealTime),
    inferHourFromIso(deal.dealTime),
    null,
    null,
    null,
    null,
    deal.comment,
    JSON.stringify(deal.raw || {}),
    new Date().toISOString()
  ).run();

  return true;
}

async function clearPositionsForAccount(db, accountId) {
  await db.prepare(`
    DELETE FROM mt5_positions
    WHERE account_id = ?
  `).bind(accountId).run();
}

async function upsertPosition(db, position) {
  await db.prepare(`
    INSERT OR REPLACE INTO mt5_positions (
      id,
      account_id,
      position_id,
      symbol,
      side,
      volume,
      open_price,
      current_price,
      sl,
      tp,
      profit,
      swap,
      magic,
      comment,
      opened_at,
      updated_at,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    position.id,
    position.accountId,
    position.positionId,
    position.symbol,
    position.side,
    position.volume,
    position.openPrice,
    position.currentPrice,
    position.sl,
    position.tp,
    position.profit,
    position.swap,
    position.magic,
    position.comment,
    position.openedAt,
    new Date().toISOString(),
    JSON.stringify(position.raw || {})
  ).run();
}

async function getMt5Summary(db, accountId = "") {
  const accountWhere = accountId ? "WHERE account_id = ?" : "";
  const bind = accountId ? [accountId] : [];

  const accounts = await db.prepare(`
    SELECT *
    FROM mt5_accounts
    ${accountWhere}
    ORDER BY last_sync_at DESC
    LIMIT 10
  `).bind(...bind).all();

  const dealsRow = await db.prepare(`
    SELECT
      COUNT(*) AS deals,
      COALESCE(SUM(net_profit), 0) AS net_profit,
      SUM(CASE WHEN net_profit > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN net_profit <= 0 THEN 1 ELSE 0 END) AS losses
    FROM mt5_deals
    ${accountWhere}
  `).bind(...bind).first();

  const positionsRow = await db.prepare(`
    SELECT
      COUNT(*) AS positions,
      COALESCE(SUM(profit), 0) AS open_profit
    FROM mt5_positions
    ${accountWhere}
  `).bind(...bind).first();

  return {
    accounts: Array.isArray(accounts.results) ? accounts.results : [],
    stats: {
      deals: Number(dealsRow?.deals || 0),
      netProfit: round(Number(dealsRow?.net_profit || 0), 2),
      wins: Number(dealsRow?.wins || 0),
      losses: Number(dealsRow?.losses || 0),
      winRate: percent(Number(dealsRow?.wins || 0), Number(dealsRow?.deals || 0)),
      openPositions: Number(positionsRow?.positions || 0),
      openProfit: round(Number(positionsRow?.open_profit || 0), 2)
    }
  };
}

function normalizeSymbol(value) {
  return String(value || "")
    .toUpperCase()
    .replaceAll(".", "")
    .replaceAll("_", "")
    .replaceAll("-", "")
    .trim();
}

function normalizeSide(value) {
  const text = String(value || "").toLowerCase();

  if (text.includes("sell") || text === "1") return "sell";
  if (text.includes("buy") || text === "0") return "buy";

  return text || "unknown";
}

function normalizeEntryType(value) {
  const text = String(value || "").toLowerCase();

  if (text.includes("out by")) return "out_by";
  if (text.includes("inout")) return "inout";
  if (text.includes("out")) return "out";
  if (text.includes("in")) return "in";
  if (text.includes("closed")) return "closed";

  return text || "unknown";
}

function normalizeIsoDate(value) {
  if (!value) return new Date().toISOString();

  const date = new Date(value);

  if (Number.isFinite(date.getTime())) {
    return date.toISOString();
  }

  const n = Number(value);

  if (Number.isFinite(n)) {
    return new Date(n > 9999999999 ? n : n * 1000).toISOString();
  }

  return new Date().toISOString();
}

function inferSetupTypeFromComment(comment = "") {
  const text = String(comment || "").toLowerCase();

  const known = [
    "trend-pullback",
    "breakout-continuation",
    "liquidity-rejection",
    "momentum-continuation",
    "range-signal",
    "late-impulse"
  ];

  return known.find((item) => text.includes(item)) || "manual-mt5";
}

function inferSessionFromIso(value) {
  const hour = inferHourFromIso(value);

  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const tokyo = hour >= 1 && hour < 10;

  if (london && newYork) return "London+NewYork";
  if (london) return "London";
  if (newYork) return "NewYork";
  if (tokyo) return "Tokyo";

  return "OffSession";
}

function inferHourFromIso(value) {
  const date = new Date(value || Date.now());

  return Number(
    date.toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );
}

function percent(a, b) {
  if (!b) return 0;

  return round((a / b) * 100, 2);
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Number(n.toFixed(digits));
}

function isAuthorized(request, secret) {
  if (!secret) return true;

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  return token === secret || bearer === secret;
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
