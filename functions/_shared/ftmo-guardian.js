const DEFAULT_CONFIG = {
  accountId: "main",
  accountSize: 10000,
  phase: "challenge",

  challengeProfitTargetPercent: 10,
  verificationProfitTargetPercent: 5,

  dailyLossLimitPercent: 5,
  maxLossLimitPercent: 10,

  dailySoftStopPercent: 2.2,
  maxDailyTrades: 4,
  maxDailyLosses: 2,
  maxOpenTrades: 4,

  normalRiskPercent: 0.25,
  sniperRiskPercent: 0.35,
  reducedRiskPercent: 0.12,
  survivalRiskPercent: 0.06,

  maxOpenRiskPercent: 1.0,
  maxCorrelatedRiskPercent: 0.45,

  minFtmoScore: 70,
  minEntryQuality: 68,
  maxExitPressure: 68,
  minHistoricalEdge: 48,

  timezone: "Europe/Paris"
};

export async function ensureFtmoGuardianTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ftmo_guardian_state (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      day_key TEXT NOT NULL,
      account_size REAL NOT NULL,
      balance REAL NOT NULL,
      equity REAL NOT NULL,
      daily_start_equity REAL NOT NULL,
      phase TEXT NOT NULL,
      locked INTEGER DEFAULT 0,
      lock_reason TEXT,
      config_json TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ftmo_guardian_log (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      pair TEXT,
      timeframe TEXT,
      direction TEXT,
      decision TEXT NOT NULL,
      risk_percent REAL,
      risk_amount REAL,
      ftmo_score REAL,
      blockers_json TEXT,
      warnings_json TEXT,
      state_json TEXT,
      scan_json TEXT
    )
  `).run();
}

export async function getFtmoStatus(db, options = {}) {
  await ensureFtmoGuardianTables(db);

  const config = normalizeConfig(options.config);
  const now = new Date();
  const bounds = getZonedDayBounds(config.timezone, now);

  const previousState = await getStoredState(db, config.accountId);
  const closedTotal = await getClosedTotal(db);
  const closedToday = await getClosedToday(db, bounds.startIso, bounds.endIso);
  const openTrades = await getOpenTrades(db);
  const openRisk = computeOpenRisk(openTrades, config.accountSize);
  const openRiskByGroup = computeOpenRiskByGroup(openTrades, config.accountSize);

  const balance = round(config.accountSize + closedTotal.pnl, 2);

  const dailyStartEquity =
    previousState?.day_key === bounds.dayKey
      ? Number(previousState.daily_start_equity || balance)
      : balance;

  const equity = balance;

  const dailyLossUsed = Math.max(0, dailyStartEquity - equity) + openRisk;
  const maxLossUsed = Math.max(0, config.accountSize - equity) + openRisk;

  const dailyLossLimit = config.accountSize * (config.dailyLossLimitPercent / 100);
  const maxLossLimit = config.accountSize * (config.maxLossLimitPercent / 100);
  const dailySoftStop = config.accountSize * (config.dailySoftStopPercent / 100);

  const dailyRiskRemaining = Math.max(0, dailyLossLimit - dailyLossUsed);
  const maxRiskRemaining = Math.max(0, maxLossLimit - maxLossUsed);

  const phaseTargetPercent =
    config.phase === "verification"
      ? config.verificationProfitTargetPercent
      : config.challengeProfitTargetPercent;

  const profitTarget = config.accountSize * (phaseTargetPercent / 100);
  const profit = balance - config.accountSize;
  const profitRemaining = Math.max(0, profitTarget - profit);

  const locked =
    dailyLossUsed >= dailySoftStop ||
    dailyLossUsed >= dailyLossLimit * 0.82 ||
    maxLossUsed >= maxLossLimit * 0.82 ||
    closedToday.losses >= config.maxDailyLosses ||
    closedToday.trades >= config.maxDailyTrades;

  const lockReason = locked
    ? buildLockReason({
        dailyLossUsed,
        dailySoftStop,
        dailyLossLimit,
        maxLossUsed,
        maxLossLimit,
        closedToday,
        config
      })
    : "";

  const status =
    locked ? "LOCKED" :
    dailyLossUsed >= dailySoftStop * 0.65 ? "CAUTION" :
    maxLossUsed >= maxLossLimit * 0.55 ? "CAUTION" :
    "SAFE";

  const state = {
    accountId: config.accountId,
    generatedAt: now.toISOString(),
    dayKey: bounds.dayKey,
    timezone: config.timezone,
    phase: config.phase,

    accountSize: config.accountSize,
    balance,
    equity,

    profit,
    profitTarget,
    profitRemaining,
    profitProgressPercent: profitTarget > 0 ? round((profit / profitTarget) * 100, 2) : 0,

    dailyStartEquity,
    dailyLossLimit,
    dailyLossUsed: round(dailyLossUsed, 2),
    dailyRiskRemaining: round(dailyRiskRemaining, 2),
    dailyRiskRemainingPercent: round((dailyRiskRemaining / config.accountSize) * 100, 3),

    maxLossLimit,
    maxLossUsed: round(maxLossUsed, 2),
    maxRiskRemaining: round(maxRiskRemaining, 2),
    maxRiskRemainingPercent: round((maxRiskRemaining / config.accountSize) * 100, 3),

    openTradesCount: openTrades.length,
    openRisk: round(openRisk, 2),
    openRiskPercent: round((openRisk / config.accountSize) * 100, 3),
    openRiskByGroup,

    today: closedToday,
    total: closedTotal,

    locked,
    lockReason,
    status,
    config
  };

  await saveState(db, state);

  return state;
}

export async function buildFtmoTradeGate(db, scan, options = {}) {
  const state = await getFtmoStatus(db, options);
  const config = state.config || DEFAULT_CONFIG;

  const pair = String(scan?.pair || "").toUpperCase();
  const direction = String(scan?.direction || "").toLowerCase();
  const timeframe = String(scan?.timeframe || "").toUpperCase();

  const blockers = [];
  const warnings = [];

  const setupScore = Number(scan?.setupQualityScore || 0);
  const entryScore = Number(scan?.entryQualityScore || 0);
  const exitPressure = Number(scan?.exitPressureScore || 99);
  const paperScore = Number(scan?.paperScore || scan?.sniperScore || 0);
  const ultraScore = Number(scan?.ultraScore || 0);
  const historicalEdge = Number(scan?.historicalEdgeScore || scan?.archiveEdgeScore || 50);
  const historicalConfidence = Number(scan?.historicalConfidence || 0);

  if (state.locked) blockers.push(state.lockReason || "FTMO guardian locked");
  if (state.dailyRiskRemaining <= config.accountSize * 0.0025) blockers.push("Daily risk remaining too low");
  if (state.maxRiskRemaining <= config.accountSize * 0.004) blockers.push("Max loss buffer too low");
  if (state.today.losses >= config.maxDailyLosses) blockers.push("Max daily losses reached");
  if (state.today.trades >= config.maxDailyTrades) blockers.push("Max daily trades reached");
  if (state.openTradesCount >= config.maxOpenTrades) blockers.push("Max open trades reached");

  if (scan?.signal !== "BUY" && scan?.signal !== "SELL") blockers.push("No directional signal");
  if (entryScore < config.minEntryQuality) blockers.push(`Entry quality too weak ${entryScore}/${config.minEntryQuality}`);
  if (exitPressure > config.maxExitPressure) blockers.push(`Exit pressure too high ${exitPressure}/${config.maxExitPressure}`);
  if (historicalEdge < config.minHistoricalEdge) blockers.push(`Historical edge too weak ${historicalEdge}/${config.minHistoricalEdge}`);

  if (scan?.lateImpulse) blockers.push("Late impulse blocked");
  if (scan?.volatilityRegime === "extreme") blockers.push("Extreme volatility blocked");
  if (scan?.setupType === "weak-signal") blockers.push("Weak setup blocked");
  if (scan?.setupType === "late-impulse") blockers.push("Late impulse setup blocked");

  const rawRiskPercent = computeGuardianRiskPercent({
    scan,
    state,
    config,
    paperScore,
    ultraScore,
    setupScore,
    entryScore,
    exitPressure,
    historicalEdge,
    historicalConfidence
  });

  const riskCapByDaily = state.dailyRiskRemaining > 0
    ? (state.dailyRiskRemaining / config.accountSize) * 100 * 0.42
    : 0;

  const riskCapByMax = state.maxRiskRemaining > 0
    ? (state.maxRiskRemaining / config.accountSize) * 100 * 0.35
    : 0;

  const riskPercent = round(Math.max(0.01, Math.min(rawRiskPercent, riskCapByDaily, riskCapByMax)), 3);
  const riskAmount = round(config.accountSize * (riskPercent / 100), 2);

  const riskGroupBlock = checkCorrelationRisk(pair, riskAmount, state, config);

  if (riskGroupBlock.blocked) {
    blockers.push(riskGroupBlock.reason);
  } else if (riskGroupBlock.warning) {
    warnings.push(riskGroupBlock.warning);
  }

  if (riskPercent < 0.03) blockers.push("Calculated risk too small for safe execution");

  if (state.today.losses === 1) warnings.push("One loss today: reduced risk mode");
  if (state.dailyLossUsed >= state.dailyLossLimit * 0.45) warnings.push("Daily drawdown caution");
  if (state.openRiskPercent >= config.maxOpenRiskPercent * 0.65) warnings.push("Open risk already elevated");
  if (historicalConfidence > 0 && historicalConfidence < 35) warnings.push("Historical confidence still small");

  const ftmoScore = computeFtmoScore({
    scan,
    state,
    riskPercent,
    paperScore,
    ultraScore,
    setupScore,
    entryScore,
    exitPressure,
    historicalEdge,
    historicalConfidence,
    blockers,
    warnings
  });

  if (ftmoScore < config.minFtmoScore) {
    blockers.push(`FTMO score too weak ${ftmoScore}/${config.minFtmoScore}`);
  }

  const allowed = blockers.length === 0;

  const gate = {
    allowed,
    decision: allowed ? "ALLOW" : "BLOCK",
    pair,
    timeframe,
    direction,
    riskPercent,
    riskAmount,
    ftmoScore,
    blockers,
    warnings,
    reason: allowed
      ? warnings.length
        ? `FTMO allowed with caution: ${warnings.join(" · ")}`
        : "FTMO guardian allowed"
      : blockers.join(" · "),
    state
  };

  await recordFtmoDecision(db, gate, scan);

  return gate;
}

async function getStoredState(db, accountId) {
  try {
    return await db.prepare(`
      SELECT *
      FROM ftmo_guardian_state
      WHERE id = ?
      LIMIT 1
    `).bind(accountId).first();
  } catch {
    return null;
  }
}

async function saveState(db, state) {
  await db.prepare(`
    INSERT OR REPLACE INTO ftmo_guardian_state (
      id,
      updated_at,
      day_key,
      account_size,
      balance,
      equity,
      daily_start_equity,
      phase,
      locked,
      lock_reason,
      config_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    state.accountId,
    state.generatedAt,
    state.dayKey,
    state.accountSize,
    state.balance,
    state.equity,
    state.dailyStartEquity,
    state.phase,
    state.locked ? 1 : 0,
    state.lockReason || "",
    JSON.stringify(state.config || {})
  ).run();
}

async function getClosedTotal(db) {
  try {
    const row = await db.prepare(`
      SELECT
        COUNT(*) AS trades,
        SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN win = 0 THEN 1 ELSE 0 END) AS losses,
        ROUND(COALESCE(SUM(pnl), 0), 2) AS pnl,
        ROUND(COALESCE(SUM(pnl_r), 0), 4) AS pnl_r
      FROM paper_trades
    `).first();

    return normalizeClosedStats(row);
  } catch {
    return emptyClosedStats();
  }
}

async function getClosedToday(db, startIso, endIso) {
  try {
    const row = await db.prepare(`
      SELECT
        COUNT(*) AS trades,
        SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN win = 0 THEN 1 ELSE 0 END) AS losses,
        ROUND(COALESCE(SUM(pnl), 0), 2) AS pnl,
        ROUND(COALESCE(SUM(pnl_r), 0), 4) AS pnl_r
      FROM paper_trades
      WHERE closed_at >= ?
        AND closed_at < ?
    `).bind(startIso, endIso).first();

    return normalizeClosedStats(row);
  } catch {
    return emptyClosedStats();
  }
}

async function getOpenTrades(db) {
  try {
    const res = await db.prepare(`
      SELECT
        id,
        pair,
        timeframe,
        direction,
        risk_percent,
        entry,
        stop_loss,
        take_profit,
        current_price,
        opened_at
      FROM paper_open_trades
    `).all();

    return Array.isArray(res.results) ? res.results : [];
  } catch {
    return [];
  }
}

function normalizeClosedStats(row) {
  const trades = Number(row?.trades || 0);
  const wins = Number(row?.wins || 0);
  const losses = Number(row?.losses || 0);

  return {
    trades,
    wins,
    losses,
    winRate: trades ? round((wins / trades) * 100, 2) : 0,
    pnl: Number(row?.pnl || 0),
    pnlR: Number(row?.pnl_r || 0)
  };
}

function emptyClosedStats() {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    pnl: 0,
    pnlR: 0
  };
}

function computeOpenRisk(openTrades, accountSize) {
  return openTrades.reduce((sum, trade) => {
    const riskPercent = Number(trade.risk_percent || 0);
    return sum + accountSize * (riskPercent / 100);
  }, 0);
}

function computeOpenRiskByGroup(openTrades, accountSize) {
  const groups = {};

  for (const trade of openTrades) {
    const pair = String(trade.pair || "").toUpperCase();
    const risk = accountSize * (Number(trade.risk_percent || 0) / 100);

    for (const group of getPairRiskGroups(pair)) {
      groups[group] = round((groups[group] || 0) + risk, 2);
    }
  }

  return groups;
}

function checkCorrelationRisk(pair, newRiskAmount, state, config) {
  const groups = getPairRiskGroups(pair);
  const maxGroupRisk = config.accountSize * (config.maxCorrelatedRiskPercent / 100);

  for (const group of groups) {
    const current = Number(state.openRiskByGroup?.[group] || 0);
    const total = current + newRiskAmount;

    if (total > maxGroupRisk) {
      return {
        blocked: true,
        reason: `Correlation risk too high on ${group}: ${round(total, 2)} > ${round(maxGroupRisk, 2)}`
      };
    }

    if (total > maxGroupRisk * 0.72) {
      return {
        blocked: false,
        warning: `Correlation risk caution on ${group}`
      };
    }
  }

  return { blocked: false, warning: "" };
}

function computeGuardianRiskPercent(data) {
  let risk = data.config.normalRiskPercent;

  if (
    data.paperScore >= 86 &&
    data.ultraScore >= 84 &&
    data.entryScore >= 80 &&
    data.setupScore >= 78 &&
    data.exitPressure <= 45 &&
    data.historicalEdge >= 60
  ) {
    risk = data.config.sniperRiskPercent;
  }

  if (data.state.today.losses >= 1) risk = Math.min(risk, data.config.reducedRiskPercent);
  if (data.state.dailyLossUsed >= data.state.dailyLossLimit * 0.35) risk = Math.min(risk, data.config.reducedRiskPercent);
  if (data.state.dailyLossUsed >= data.state.dailyLossLimit * 0.55) risk = Math.min(risk, data.config.survivalRiskPercent);
  if (data.state.maxLossUsed >= data.state.maxLossLimit * 0.45) risk = Math.min(risk, data.config.survivalRiskPercent);

  if (data.scan?.pair === "BTCUSD") risk *= 0.55;
  if (data.scan?.pair === "XAUUSD") risk *= 0.75;
  if (String(data.scan?.pair || "").startsWith("GBP")) risk *= 0.9;

  if (data.historicalConfidence > 0 && data.historicalConfidence < 30) risk *= 0.65;
  if (data.exitPressure >= 60) risk *= 0.65;
  if (data.scan?.volatilityRegime === "elevated") risk *= 0.7;

  return round(Math.max(0.01, risk), 3);
}

function computeFtmoScore(data) {
  let score = 50;

  score += (data.paperScore - 65) * 0.22;
  score += (data.ultraScore - 65) * 0.16;
  score += (data.entryScore - 65) * 0.18;
  score += (data.setupScore - 65) * 0.14;
  score += (data.historicalEdge - 50) * 0.16;
  score -= Math.max(0, data.exitPressure - 45) * 0.20;

  score += data.state.status === "SAFE" ? 8 : 0;
  score -= data.state.status === "CAUTION" ? 8 : 0;
  score -= data.state.locked ? 30 : 0;

  score -= data.state.today.losses * 8;
  score -= data.state.openRiskPercent > 0.75 ? 8 : 0;
  score -= data.riskPercent > 0.35 ? 8 : 0;

  score -= data.blockers.length * 18;
  score -= data.warnings.length * 3;

  return Math.round(clamp(score, 1, 99));
}

async function recordFtmoDecision(db, gate, scan) {
  try {
    await db.prepare(`
      INSERT INTO ftmo_guardian_log (
        id,
        created_at,
        pair,
        timeframe,
        direction,
        decision,
        risk_percent,
        risk_amount,
        ftmo_score,
        blockers_json,
        warnings_json,
        state_json,
        scan_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      `ftmo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      new Date().toISOString(),
      gate.pair,
      gate.timeframe,
      gate.direction,
      gate.decision,
      gate.riskPercent,
      gate.riskAmount,
      gate.ftmoScore,
      JSON.stringify(gate.blockers || []),
      JSON.stringify(gate.warnings || []),
      JSON.stringify(slimState(gate.state)),
      JSON.stringify(slimScan(scan))
    ).run();
  } catch {
    // Guardian logging is optional.
  }
}

function slimState(state) {
  return {
    status: state.status,
    locked: state.locked,
    lockReason: state.lockReason,
    balance: state.balance,
    equity: state.equity,
    dailyLossUsed: state.dailyLossUsed,
    dailyRiskRemaining: state.dailyRiskRemaining,
    maxLossUsed: state.maxLossUsed,
    maxRiskRemaining: state.maxRiskRemaining,
    openRiskPercent: state.openRiskPercent,
    today: state.today
  };
}

function slimScan(scan) {
  return {
    pair: scan?.pair,
    timeframe: scan?.timeframe,
    signal: scan?.signal,
    setupType: scan?.setupType,
    ultraScore: scan?.ultraScore,
    paperScore: scan?.paperScore,
    entryQualityScore: scan?.entryQualityScore,
    setupQualityScore: scan?.setupQualityScore,
    exitPressureScore: scan?.exitPressureScore,
    historicalEdgeScore: scan?.historicalEdgeScore,
    historicalConfidence: scan?.historicalConfidence
  };
}

function buildLockReason(data) {
  if (data.closedToday.losses >= data.config.maxDailyLosses) {
    return `Daily loss count reached: ${data.closedToday.losses}/${data.config.maxDailyLosses}`;
  }

  if (data.closedToday.trades >= data.config.maxDailyTrades) {
    return `Daily trade limit reached: ${data.closedToday.trades}/${data.config.maxDailyTrades}`;
  }

  if (data.dailyLossUsed >= data.dailyLossLimit * 0.82) {
    return "Daily loss limit danger zone";
  }

  if (data.dailyLossUsed >= data.dailySoftStop) {
    return "Daily soft stop reached";
  }

  if (data.maxLossUsed >= data.maxLossLimit * 0.82) {
    return "Max loss danger zone";
  }

  return "FTMO guardian locked";
}

function getPairRiskGroups(pair) {
  const p = String(pair || "").toUpperCase();
  const groups = [];

  if (p.includes("USD")) groups.push("USD");
  if (p.includes("EUR")) groups.push("EUR");
  if (p.includes("GBP")) groups.push("GBP");
  if (p.includes("JPY")) groups.push("JPY");
  if (p.includes("CHF")) groups.push("CHF");
  if (p.includes("CAD")) groups.push("CAD");
  if (p.includes("AUD") || p.includes("NZD")) groups.push("AUD_NZD");
  if (p === "XAUUSD") groups.push("GOLD_USD");
  if (p === "BTCUSD") groups.push("BTC_USD");

  return [...new Set(groups)];
}

function normalizeConfig(input = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...input,
    accountSize: Number(input.accountSize || DEFAULT_CONFIG.accountSize)
  };
}

function getZonedDayBounds(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;

  const dayKey = `${y}-${m}-${d}`;
  const utcMidnight = new Date(`${dayKey}T00:00:00.000Z`);
  const offsetMinutes = getTimezoneOffsetMinutes(timeZone, utcMidnight);
  const start = new Date(utcMidnight.getTime() - offsetMinutes * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return {
    dayKey,
    startIso: start.toISOString(),
    endIso: end.toISOString()
  };
}

function getTimezoneOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const filled = {};
  for (const part of parts) filled[part.type] = part.value;

  const asUtc = Date.UTC(
    Number(filled.year),
    Number(filled.month) - 1,
    Number(filled.day),
    Number(filled.hour),
    Number(filled.minute),
    Number(filled.second)
  );

  return (asUtc - date.getTime()) / 60_000;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
