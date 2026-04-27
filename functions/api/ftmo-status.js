import {
  buildAccountConfig,
  buildGuardianContext
} from "../_shared/ftmo-guardian.js";

const MODEL_VERSION = "ftmo-status-v2-guardian-linked";

export async function onRequestGet(context) {
  return handleFtmoStatus(context);
}

export async function onRequestPost(context) {
  return handleFtmoStatus(context);
}

async function handleFtmoStatus(context) {
  try {
    const env = context.env || {};
    const db = env.DB;

    if (!db) {
      return json({
        ok: false,
        source: "ftmo-status",
        version: MODEL_VERSION,
        error: "Missing DB binding"
      }, 500);
    }

    if (!isAuthorized(context.request, env.SYNC_SECRET || "")) {
      return json({
        ok: false,
        source: "ftmo-status",
        version: MODEL_VERSION,
        error: "Unauthorized"
      }, 401);
    }

    await ensureFtmoStatusTables(db);

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    const timeframe =
      normalizeTimeframe(url.searchParams.get("timeframe") || body.timeframe) ||
      "M15";

    const accountOverrides = buildAccountOverrides(url, body);
    const account = buildAccountConfig(env, accountOverrides);

    const guardian = await buildGuardianContext(db, account, timeframe);

    const profitTargetAmount = account.startingBalance * (account.profitTargetPercent / 100);
    const profitTargetLevel = account.startingBalance + profitTargetAmount;

    const profitProgress = account.profitTargetPercent > 0
      ? ((guardian.equity - account.startingBalance) / Math.max(1, profitTargetAmount)) * 100
      : 0;

    const dailyLossRemainingPercent = percentOf(
      guardian.dailyLossRemaining,
      account.startingBalance
    );

    const totalLossRemainingPercent = percentOf(
      guardian.totalLossRemaining,
      account.startingBalance
    );

    const openRiskPercent = percentOf(
      guardian.openRisk,
      account.startingBalance
    );

    const availableNewTradeRiskPercent = percentOf(
      guardian.availableNewTradeRisk,
      account.startingBalance
    );

    const recommendedRiskPercent = computeRecommendedRiskPercent({
      account,
      guardian,
      availableNewTradeRiskPercent,
      dailyLossRemainingPercent,
      totalLossRemainingPercent
    });

    const decision = {
      canTrade: !guardian.status.locked,
      canOpenNewTrade:
        !guardian.status.locked &&
        guardian.availableNewTradeRisk > 0 &&
        guardian.dailyTrades < account.maxDailyTrades,
      recommendedMaxRiskPercent: round(recommendedRiskPercent, 3),
      recommendedMaxRiskAmount: round(
        account.startingBalance * (recommendedRiskPercent / 100),
        2
      ),
      reason: guardian.status.reason
    };

    const danger = buildDangerReport({
      account,
      guardian,
      dailyLossRemainingPercent,
      totalLossRemainingPercent,
      openRiskPercent,
      availableNewTradeRiskPercent
    });

    const score = computeFtmoHealthScore({
      account,
      guardian,
      dailyLossRemainingPercent,
      totalLossRemainingPercent,
      openRiskPercent,
      availableNewTradeRiskPercent,
      danger
    });

    const payload = {
      ok: true,
      source: "ftmo-status",
      version: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      timeframe,

      account: {
        phase: account.phase,
        startingBalance: round(account.startingBalance, 2),
        profitTargetPercent: round(account.profitTargetPercent, 2),
        dailyLossPercent: round(account.dailyLossPercent, 2),
        maxLossPercent: round(account.maxLossPercent, 2),
        maxOpenRiskPercent: round(account.maxOpenRiskPercent, 2),
        maxTradeRiskPercent: round(account.maxTradeRiskPercent, 2),
        maxDailyTrades: account.maxDailyTrades,
        maxDailyLosses: account.maxDailyLosses,
        maxConsecutiveLosses: account.maxConsecutiveLosses,
        maxSameCurrencyTrades: account.maxSameCurrencyTrades,
        maxUsdTrades: account.maxUsdTrades
      },

      status: {
        ...guardian.status,
        healthScore: score.healthScore,
        healthLabel: score.healthLabel
      },

      metrics: {
        balance: round(guardian.balance, 2),
        equity: round(guardian.equity, 2),
        dailyStartEquity: round(guardian.dailyStartEquity, 2),

        totalClosedPnl: round(guardian.totalClosedPnl, 2),
        realizedPnlToday: round(guardian.realizedPnl, 2),
        openPnl: round(guardian.openPnl, 2),

        profitTargetAmount: round(profitTargetAmount, 2),
        profitTargetLevel: round(profitTargetLevel, 2),
        profitRemaining: round(Math.max(0, profitTargetLevel - guardian.equity), 2),
        profitProgress: round(profitProgress, 2),

        dailyLossRemaining: round(guardian.dailyLossRemaining, 2),
        dailyLossRemainingPercent: round(dailyLossRemainingPercent, 3),

        totalLossRemaining: round(guardian.totalLossRemaining, 2),
        totalLossRemainingPercent: round(totalLossRemainingPercent, 3),

        openRisk: round(guardian.openRisk, 2),
        openRiskPercent: round(openRiskPercent, 3),

        maxOpenRiskAmount: round(guardian.maxOpenRiskAmount, 2),
        maxTradeRiskAmount: round(guardian.maxTradeRiskAmount, 2),

        availableNewTradeRisk: round(guardian.availableNewTradeRisk, 2),
        availableNewTradeRiskPercent: round(availableNewTradeRiskPercent, 3),

        dailyTrades: guardian.dailyTrades,
        dailyLosses: guardian.dailyLosses,
        consecutiveLosses: guardian.consecutiveLosses,
        openTrades: guardian.openTrades.length
      },

      decision,

      danger,

      exposure: {
        currencyExposure: guardian.currencyExposure,
        valuedOpenTrades: guardian.valuedOpenTrades
      },

      guardian: {
        version: guardian.version,
        dateKey: guardian.dateKey,
        status: guardian.status
      }
    };

    await saveStatusSnapshot(db, {
      dateKey: guardian.dateKey,
      phase: account.phase,
      timeframe,
      status: guardian.status.level,
      locked: guardian.status.locked ? 1 : 0,
      healthScore: score.healthScore,

      startingBalance: account.startingBalance,
      balance: guardian.balance,
      equity: guardian.equity,
      dailyStartEquity: guardian.dailyStartEquity,

      totalClosedPnl: guardian.totalClosedPnl,
      realizedPnl: guardian.realizedPnl,
      openPnl: guardian.openPnl,
      openRisk: guardian.openRisk,

      dailyLossRemaining: guardian.dailyLossRemaining,
      totalLossRemaining: guardian.totalLossRemaining,
      availableNewTradeRisk: guardian.availableNewTradeRisk,

      dailyTrades: guardian.dailyTrades,
      dailyLosses: guardian.dailyLosses,
      consecutiveLosses: guardian.consecutiveLosses,

      reason: guardian.status.reason
    });

    return json(payload);
  } catch (error) {
    return json({
      ok: false,
      source: "ftmo-status",
      version: MODEL_VERSION,
      error: String(error?.message || error || "ftmo-status-error")
    }, 500);
  }
}

async function ensureFtmoStatusTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ftmo_status_snapshots (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      date_key TEXT NOT NULL,
      timeframe TEXT,
      phase TEXT,
      status TEXT,
      locked INTEGER,
      health_score REAL,
      starting_balance REAL,
      balance REAL,
      equity REAL,
      daily_start_equity REAL,
      total_closed_pnl REAL,
      realized_pnl REAL,
      open_pnl REAL,
      open_risk REAL,
      daily_loss_remaining REAL,
      total_loss_remaining REAL,
      available_new_trade_risk REAL,
      daily_trades INTEGER,
      daily_losses INTEGER,
      consecutive_losses INTEGER,
      reason TEXT
    )
  `).run();

  await addColumnIfMissing(db, "ftmo_status_snapshots", "timeframe", "TEXT");
  await addColumnIfMissing(db, "ftmo_status_snapshots", "health_score", "REAL");
  await addColumnIfMissing(db, "ftmo_status_snapshots", "total_closed_pnl", "REAL");
  await addColumnIfMissing(db, "ftmo_status_snapshots", "daily_trades", "INTEGER");
  await addColumnIfMissing(db, "ftmo_status_snapshots", "daily_losses", "INTEGER");
  await addColumnIfMissing(db, "ftmo_status_snapshots", "consecutive_losses", "INTEGER");
  await addColumnIfMissing(db, "ftmo_status_snapshots", "reason", "TEXT");
}

async function addColumnIfMissing(db, table, column, type) {
  try {
    await db.prepare(`
      ALTER TABLE ${table}
      ADD COLUMN ${column} ${type}
    `).run();
  } catch {
    // Column already exists.
  }
}

function buildAccountOverrides(url, body) {
  return {
    phase: readParam(url, body, "phase"),

    startingBalance: readParam(url, body, "startingBalance"),
    profitTargetPercent: readParam(url, body, "profitTargetPercent"),
    dailyLossPercent: readParam(url, body, "dailyLossPercent"),
    maxLossPercent: readParam(url, body, "maxLossPercent"),

    maxOpenRiskPercent: readParam(url, body, "maxOpenRiskPercent"),
    maxTradeRiskPercent: readParam(url, body, "maxTradeRiskPercent"),

    cautionDailyBufferPercent: readParam(url, body, "cautionDailyBufferPercent"),
    dangerDailyBufferPercent: readParam(url, body, "dangerDailyBufferPercent"),

    maxDailyTrades: readParam(url, body, "maxDailyTrades"),
    maxDailyLosses: readParam(url, body, "maxDailyLosses"),
    maxConsecutiveLosses: readParam(url, body, "maxConsecutiveLosses"),

    maxSameCurrencyTrades: readParam(url, body, "maxSameCurrencyTrades"),
    maxUsdTrades: readParam(url, body, "maxUsdTrades"),

    minDailyRiskBufferMultiplier: readParam(url, body, "minDailyRiskBufferMultiplier"),
    minTotalRiskBufferMultiplier: readParam(url, body, "minTotalRiskBufferMultiplier")
  };
}

function readParam(url, body, key) {
  const value = url.searchParams.get(key) ?? body?.[key];

  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return value;
}

function computeRecommendedRiskPercent(data) {
  const account = data.account;
  const guardian = data.guardian;

  if (guardian.status.locked) return 0;

  let risk = account.maxTradeRiskPercent;

  risk = Math.min(risk, data.availableNewTradeRiskPercent);

  if (guardian.status.level === "danger") {
    risk = Math.min(risk, 0.05);
  }

  if (guardian.status.level === "caution") {
    risk = Math.min(risk, 0.12);
  }

  if (guardian.dailyLosses >= 1) {
    risk = Math.min(risk, 0.12);
  }

  if (guardian.consecutiveLosses >= 1) {
    risk = Math.min(risk, 0.12);
  }

  if (data.dailyLossRemainingPercent <= 1.25) {
    risk = Math.min(risk, 0.08);
  }

  if (data.totalLossRemainingPercent <= 2.5) {
    risk = Math.min(risk, 0.08);
  }

  if (guardian.dailyTrades >= account.maxDailyTrades - 1) {
    risk = Math.min(risk, 0.08);
  }

  if (data.openRiskPercent >= account.maxOpenRiskPercent * 0.75) {
    risk = Math.min(risk, 0.08);
  }

  return Math.max(0, risk);
}

function buildDangerReport(data) {
  const warnings = [];
  const blockers = [];

  const account = data.account;
  const guardian = data.guardian;

  if (guardian.status.locked) {
    blockers.push(guardian.status.reason);
  }

  if (data.dailyLossRemainingPercent <= 0) {
    blockers.push("Daily loss limit reached.");
  } else if (data.dailyLossRemainingPercent <= account.dangerDailyBufferPercent) {
    warnings.push("Daily loss buffer is critical.");
  } else if (data.dailyLossRemainingPercent <= account.cautionDailyBufferPercent) {
    warnings.push("Daily loss buffer is low.");
  }

  if (data.totalLossRemainingPercent <= 0) {
    blockers.push("Maximum loss limit reached.");
  } else if (data.totalLossRemainingPercent <= 1.5) {
    warnings.push("Maximum loss buffer is critical.");
  } else if (data.totalLossRemainingPercent <= 2.5) {
    warnings.push("Maximum loss buffer is low.");
  }

  if (guardian.dailyLosses >= account.maxDailyLosses) {
    blockers.push("Daily loss count limit reached.");
  } else if (guardian.dailyLosses === account.maxDailyLosses - 1) {
    warnings.push("One more losing trade will lock the day.");
  }

  if (guardian.consecutiveLosses >= account.maxConsecutiveLosses) {
    blockers.push("Consecutive loss limit reached.");
  } else if (guardian.consecutiveLosses === account.maxConsecutiveLosses - 1) {
    warnings.push("One more consecutive loss will lock trading.");
  }

  if (guardian.dailyTrades >= account.maxDailyTrades) {
    blockers.push("Daily trade limit reached.");
  } else if (guardian.dailyTrades >= account.maxDailyTrades - 1) {
    warnings.push("Daily trade count is near the limit.");
  }

  if (guardian.availableNewTradeRisk <= 0) {
    blockers.push("No risk budget available for a new trade.");
  }

  if (data.openRiskPercent >= account.maxOpenRiskPercent) {
    blockers.push("Open risk cap reached.");
  } else if (data.openRiskPercent >= account.maxOpenRiskPercent * 0.75) {
    warnings.push("Open risk is close to the cap.");
  }

  for (const [currency, exposure] of Object.entries(guardian.currencyExposure || {})) {
    if (currency === "USD" && Number(exposure.trades || 0) >= account.maxUsdTrades) {
      warnings.push("USD exposure is high.");
    }

    if (currency !== "USD" && Number(exposure.trades || 0) >= account.maxSameCurrencyTrades) {
      warnings.push(`${currency} exposure is high.`);
    }
  }

  return {
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    level:
      blockers.length > 0 ? "blocked" :
      warnings.length >= 3 ? "danger" :
      warnings.length >= 1 ? "caution" :
      "clean"
  };
}

function computeFtmoHealthScore(data) {
  let score = 100;

  if (data.guardian.status.locked) score -= 100;

  score -= Math.max(0, 5 - data.dailyLossRemainingPercent) * 8;
  score -= Math.max(0, 10 - data.totalLossRemainingPercent) * 3;
  score -= Math.max(0, data.openRiskPercent - 0.5) * 20;
  score -= data.guardian.dailyLosses * 18;
  score -= data.guardian.consecutiveLosses * 22;
  score -= Math.max(0, data.guardian.dailyTrades - 3) * 7;
  score -= data.danger.warnings.length * 6;
  score -= data.danger.blockers.length * 25;

  const finalScore = clamp(score, 0, 100);

  return {
    healthScore: round(finalScore, 1),
    healthLabel:
      finalScore >= 85 ? "excellent" :
      finalScore >= 70 ? "safe" :
      finalScore >= 50 ? "caution" :
      finalScore >= 25 ? "danger" :
      "locked"
  };
}

async function saveStatusSnapshot(db, snapshot) {
  try {
    await db.prepare(`
      INSERT INTO ftmo_status_snapshots (
        id,
        created_at,
        date_key,
        timeframe,
        phase,
        status,
        locked,
        health_score,
        starting_balance,
        balance,
        equity,
        daily_start_equity,
        total_closed_pnl,
        realized_pnl,
        open_pnl,
        open_risk,
        daily_loss_remaining,
        total_loss_remaining,
        available_new_trade_risk,
        daily_trades,
        daily_losses,
        consecutive_losses,
        reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      `ftmo_status_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      new Date().toISOString(),
      snapshot.dateKey,
      snapshot.timeframe,
      snapshot.phase,
      snapshot.status,
      snapshot.locked,
      snapshot.healthScore,
      snapshot.startingBalance,
      snapshot.balance,
      snapshot.equity,
      snapshot.dailyStartEquity,
      snapshot.totalClosedPnl,
      snapshot.realizedPnl,
      snapshot.openPnl,
      snapshot.openRisk,
      snapshot.dailyLossRemaining,
      snapshot.totalLossRemaining,
      snapshot.availableNewTradeRisk,
      snapshot.dailyTrades,
      snapshot.dailyLosses,
      snapshot.consecutiveLosses,
      snapshot.reason
    ).run();
  } catch {
    // Snapshot is optional.
  }
}

function normalizeTimeframe(value) {
  const timeframe = String(value || "").toUpperCase().trim();

  return ["M5", "M15", "H1", "H4"].includes(timeframe) ? timeframe : "";
}

function percentOf(value, total) {
  const n = Number(value);
  const d = Number(total);

  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;

  return (n / d) * 100;
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Number(n.toFixed(digits));
}

function clamp(value, min = 0, max = 100) {
  const n = Number(value);

  if (!Number.isFinite(n)) return min;

  return Math.max(min, Math.min(max, n));
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
