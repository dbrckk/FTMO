const GUARDIAN_VERSION = "ftmo-guardian-v1";

const DEFAULT_ACCOUNT = {
  phase: "challenge",
  startingBalance: 10000,
  profitTargetPercent: 10,
  dailyLossPercent: 5,
  maxLossPercent: 10,
  maxOpenRiskPercent: 1,
  maxTradeRiskPercent: 0.35,
  cautionDailyBufferPercent: 1.25,
  dangerDailyBufferPercent: 0.65,
  maxDailyTrades: 5,
  maxDailyLosses: 2,
  maxConsecutiveLosses: 2,
  maxSameCurrencyTrades: 2,
  maxUsdTrades: 2,
  minDailyRiskBufferMultiplier: 1.35,
  minTotalRiskBufferMultiplier: 1.25
};

export async function applyFtmoGuardianToScans(db, scans, options = {}) {
  await ensureFtmoGuardianTables(db);

  const account = buildAccountConfig(options.env || {}, options.account || {});
  const timeframe = normalizeTimeframe(options.timeframe) || "M15";

  const context = await buildGuardianContext(db, account, timeframe);

  const guarded = [];

  for (const scan of scans || []) {
    guarded.push(await evaluateFtmoTrade(db, scan, {
      account,
      context,
      timeframe,
      mode: options.mode || "paper"
    }));
  }

  return guarded;
}

export async function evaluateFtmoTrade(db, scan, options = {}) {
  const account = options.account || buildAccountConfig(options.env || {}, options.account || {});
  const timeframe = normalizeTimeframe(options.timeframe || scan?.timeframe) || "M15";
  const context = options.context || await buildGuardianContext(db, account, timeframe);

  const trade = normalizeCandidate(scan, account);
  const blockers = [];
  const warnings = [];

  if (!scan || scan.signal === "WAIT" || (scan.direction !== "buy" && scan.direction !== "sell")) {
    blockers.push("No valid trade direction.");
  }

  if (context.status.locked) {
    blockers.push(`FTMO locked: ${context.status.reason}`);
  }

  if (context.dailyTrades >= account.maxDailyTrades) {
    blockers.push(`Daily trade limit reached: ${context.dailyTrades}/${account.maxDailyTrades}.`);
  }

  if (context.dailyLosses >= account.maxDailyLosses) {
    blockers.push(`Daily loss limit reached: ${context.dailyLosses}/${account.maxDailyLosses}.`);
  }

  if (context.consecutiveLosses >= account.maxConsecutiveLosses) {
    blockers.push(`Consecutive loss limit reached: ${context.consecutiveLosses}/${account.maxConsecutiveLosses}.`);
  }

  if (context.availableNewTradeRisk <= 0) {
    blockers.push("No available FTMO risk budget.");
  }

  if (trade.riskAmount <= 0) {
    blockers.push("Invalid trade risk amount.");
  }

  if (trade.riskAmount > context.availableNewTradeRisk) {
    blockers.push(
      `Trade risk too high: ${money(trade.riskAmount)} > available ${money(context.availableNewTradeRisk)}.`
    );
  }

  if (trade.riskPercent > account.maxTradeRiskPercent) {
    blockers.push(
      `Trade risk percent too high: ${round(trade.riskPercent, 3)}% > ${account.maxTradeRiskPercent}%.`
    );
  }

  if ((context.openRisk + trade.riskAmount) > context.maxOpenRiskAmount) {
    blockers.push(
      `Open risk cap exceeded: ${money(context.openRisk + trade.riskAmount)} > ${money(context.maxOpenRiskAmount)}.`
    );
  }

  const dailyBufferAfterSl = context.dailyLossRemaining - trade.riskAmount;
  const totalBufferAfterSl = context.totalLossRemaining - trade.riskAmount;

  if (dailyBufferAfterSl <= 0) {
    blockers.push("SL would violate daily loss limit.");
  }

  if (totalBufferAfterSl <= 0) {
    blockers.push("SL would violate maximum loss limit.");
  }

  if (dailyBufferAfterSl < trade.riskAmount * account.minDailyRiskBufferMultiplier) {
    warnings.push("Daily buffer after SL would be low.");
  }

  if (totalBufferAfterSl < trade.riskAmount * account.minTotalRiskBufferMultiplier) {
    warnings.push("Total buffer after SL would be low.");
  }

  const exposure = computeCandidateExposure(context.currencyExposure, trade);

  if (exposure.usdTrades > account.maxUsdTrades) {
    blockers.push(`USD exposure too high: ${exposure.usdTrades}/${account.maxUsdTrades}.`);
  }

  for (const [group, count] of Object.entries(exposure.groupTrades)) {
    if (group !== "USD" && count > account.maxSameCurrencyTrades) {
      blockers.push(`${group} exposure too high: ${count}/${account.maxSameCurrencyTrades}.`);
    }
  }

  if (trade.pair === "XAUUSD" && exposure.groupTrades.GOLD_USD > 1) {
    blockers.push("Only one XAUUSD trade allowed.");
  }

  if (trade.pair === "BTCUSD" && exposure.groupTrades.BTC_USD > 1) {
    blockers.push("Only one BTCUSD trade allowed.");
  }

  if (scan?.volatilityRegime === "extreme") {
    blockers.push("Extreme volatility blocked by FTMO Guardian.");
  }

  if (scan?.lateImpulse) {
    blockers.push("Late impulse blocked by FTMO Guardian.");
  }

  if (Number(scan?.exitPressureScore || 0) >= 72) {
    blockers.push(`Exit pressure too high: ${scan.exitPressureScore}/100.`);
  }

  if (Number(scan?.entryQualityScore || 0) < 60) {
    blockers.push(`Entry quality too low: ${scan.entryQualityScore || 0}/100.`);
  }

  if (Number(scan?.setupQualityScore || 0) < 58) {
    blockers.push(`Setup quality too low: ${scan.setupQualityScore || 0}/100.`);
  }

  const recommendedRiskPercent = computeGuardianRiskPercent({
    account,
    context,
    scan,
    warnings,
    trade
  });

  const allowed = blockers.length === 0 && recommendedRiskPercent > 0;

  const ftmoGuardian = {
    version: GUARDIAN_VERSION,
    allowed,
    status: context.status.level,
    label: context.status.label,
    reason: allowed
      ? buildAllowedReason(context, trade, recommendedRiskPercent, warnings)
      : blockers.join(" · "),
    blockers,
    warnings,

    recommendedRiskPercent: round(recommendedRiskPercent, 3),
    recommendedRiskAmount: round(account.startingBalance * (recommendedRiskPercent / 100), 2),

    tradeRiskPercent: round(trade.riskPercent, 3),
    tradeRiskAmount: round(trade.riskAmount, 2),

    dailyLossRemaining: round(context.dailyLossRemaining, 2),
    totalLossRemaining: round(context.totalLossRemaining, 2),
    availableNewTradeRisk: round(context.availableNewTradeRisk, 2),
    availableNewTradeRiskPercent: round(percentOf(context.availableNewTradeRisk, account.startingBalance), 3),

    openRisk: round(context.openRisk, 2),
    openRiskPercent: round(percentOf(context.openRisk, account.startingBalance), 3),

    dailyTrades: context.dailyTrades,
    dailyLosses: context.dailyLosses,
    consecutiveLosses: context.consecutiveLosses,

    equity: round(context.equity, 2),
    balance: round(context.balance, 2),
    dailyStartEquity: round(context.dailyStartEquity, 2),

    currencyExposure: context.currencyExposure,
    candidateExposure: exposure
  };

  return {
    ...scan,
    ftmoGuardian,
    ftmoAllowed: allowed,
    ftmoStatus: context.status.level,
    ftmoReason: ftmoGuardian.reason,
    ftmoRecommendedRiskPercent: ftmoGuardian.recommendedRiskPercent,
    ftmoRecommendedRiskAmount: ftmoGuardian.recommendedRiskAmount,
    tradeAllowed: Boolean(scan?.tradeAllowed && allowed),
    tradeReason: allowed
      ? `${scan?.tradeReason || "Accepted"} FTMO: ${ftmoGuardian.reason}`
      : `FTMO blocked: ${ftmoGuardian.reason}`,
    paperScore: allowed
      ? Number(scan?.paperScore || 0)
      : Math.max(0, Number(scan?.paperScore || 0) - 18)
  };
}

export async function buildGuardianContext(db, account, timeframe = "M15") {
  await ensureFtmoGuardianTables(db);

  const dateKey = getParisDateKey(new Date());
  const dailyAnchor = await getOrCreateDailyAnchor(db, account, dateKey, timeframe);

  const totalClosedPnl = await getTotalClosedPnl(db);
  const closedStats = await getClosedStats(db, dateKey);
  const openTrades = await getOpenTrades(db, timeframe);
  const valuation = await valueOpenTrades(db, openTrades, timeframe, account);

  const balance = account.startingBalance + totalClosedPnl;
  const equity = balance + valuation.openPnl;

  const maxDailyLossAmount = account.startingBalance * (account.dailyLossPercent / 100);
  const maxTotalLossAmount = account.startingBalance * (account.maxLossPercent / 100);

  const dailyLossFloor = dailyAnchor.dailyStartEquity - maxDailyLossAmount;
  const maxLossFloor = account.startingBalance - maxTotalLossAmount;

  const dailyLossRemaining = Math.max(0, equity - dailyLossFloor);
  const totalLossRemaining = Math.max(0, equity - maxLossFloor);

  const maxOpenRiskAmount = account.startingBalance * (account.maxOpenRiskPercent / 100);
  const maxTradeRiskAmount = account.startingBalance * (account.maxTradeRiskPercent / 100);

  const availableRiskByDaily = Math.max(0, dailyLossRemaining * 0.72 - valuation.openRisk);
  const availableRiskByTotal = Math.max(0, totalLossRemaining * 0.72 - valuation.openRisk);
  const availableRiskByOpenCap = Math.max(0, maxOpenRiskAmount - valuation.openRisk);

  const availableNewTradeRisk = Math.max(
    0,
    Math.min(
      maxTradeRiskAmount,
      availableRiskByDaily,
      availableRiskByTotal,
      availableRiskByOpenCap
    )
  );

  const consecutiveLosses = await getConsecutiveLosses(db);
  const dailyTrades = Number(closedStats.closedTrades || 0) + openTrades.length;
  const dailyLosses = Number(closedStats.losses || 0);

  const currencyExposure = buildCurrencyExposure(valuation.valuedTrades);
  const status = computeStatus({
    account,
    equity,
    dailyLossRemaining,
    totalLossRemaining,
    dailyLossRemainingPercent: percentOf(dailyLossRemaining, account.startingBalance),
    totalLossRemainingPercent: percentOf(totalLossRemaining, account.startingBalance),
    dailyTrades,
    dailyLosses,
    consecutiveLosses,
    availableNewTradeRisk
  });

  return {
    version: GUARDIAN_VERSION,
    dateKey,
    account,
    status,

    balance,
    equity,
    dailyStartEquity: dailyAnchor.dailyStartEquity,

    totalClosedPnl,
    realizedPnl: Number(closedStats.realizedPnl || 0),
    openPnl: valuation.openPnl,
    openRisk: valuation.openRisk,

    dailyLossRemaining,
    totalLossRemaining,
    maxOpenRiskAmount,
    maxTradeRiskAmount,
    availableNewTradeRisk,

    dailyTrades,
    dailyLosses,
    consecutiveLosses,

    openTrades,
    valuedOpenTrades: valuation.valuedTrades,
    currencyExposure
  };
}

export function buildAccountConfig(env = {}, overrides = {}) {
  const phase = String(
    overrides.phase ||
    env.FTMO_PHASE ||
    DEFAULT_ACCOUNT.phase
  ).toLowerCase();

  const phaseDefaults = getPhaseDefaults(phase);

  return {
    phase,
    startingBalance: readNumber(overrides.startingBalance, env.FTMO_STARTING_BALANCE, DEFAULT_ACCOUNT.startingBalance),
    profitTargetPercent: readNumber(overrides.profitTargetPercent, env.FTMO_PROFIT_TARGET_PERCENT, phaseDefaults.profitTargetPercent),
    dailyLossPercent: readNumber(overrides.dailyLossPercent, env.FTMO_DAILY_LOSS_PERCENT, DEFAULT_ACCOUNT.dailyLossPercent),
    maxLossPercent: readNumber(overrides.maxLossPercent, env.FTMO_MAX_LOSS_PERCENT, DEFAULT_ACCOUNT.maxLossPercent),
    maxOpenRiskPercent: readNumber(overrides.maxOpenRiskPercent, env.FTMO_MAX_OPEN_RISK_PERCENT, DEFAULT_ACCOUNT.maxOpenRiskPercent),
    maxTradeRiskPercent: readNumber(overrides.maxTradeRiskPercent, env.FTMO_MAX_TRADE_RISK_PERCENT, DEFAULT_ACCOUNT.maxTradeRiskPercent),
    cautionDailyBufferPercent: readNumber(overrides.cautionDailyBufferPercent, env.FTMO_CAUTION_DAILY_BUFFER_PERCENT, DEFAULT_ACCOUNT.cautionDailyBufferPercent),
    dangerDailyBufferPercent: readNumber(overrides.dangerDailyBufferPercent, env.FTMO_DANGER_DAILY_BUFFER_PERCENT, DEFAULT_ACCOUNT.dangerDailyBufferPercent),
    maxDailyTrades: readNumber(overrides.maxDailyTrades, env.FTMO_MAX_DAILY_TRADES, DEFAULT_ACCOUNT.maxDailyTrades),
    maxDailyLosses: readNumber(overrides.maxDailyLosses, env.FTMO_MAX_DAILY_LOSSES, DEFAULT_ACCOUNT.maxDailyLosses),
    maxConsecutiveLosses: readNumber(overrides.maxConsecutiveLosses, env.FTMO_MAX_CONSECUTIVE_LOSSES, DEFAULT_ACCOUNT.maxConsecutiveLosses),
    maxSameCurrencyTrades: readNumber(overrides.maxSameCurrencyTrades, env.FTMO_MAX_SAME_CURRENCY_TRADES, DEFAULT_ACCOUNT.maxSameCurrencyTrades),
    maxUsdTrades: readNumber(overrides.maxUsdTrades, env.FTMO_MAX_USD_TRADES, DEFAULT_ACCOUNT.maxUsdTrades),
    minDailyRiskBufferMultiplier: readNumber(overrides.minDailyRiskBufferMultiplier, env.FTMO_MIN_DAILY_RISK_BUFFER_MULTIPLIER, DEFAULT_ACCOUNT.minDailyRiskBufferMultiplier),
    minTotalRiskBufferMultiplier: readNumber(overrides.minTotalRiskBufferMultiplier, env.FTMO_MIN_TOTAL_RISK_BUFFER_MULTIPLIER, DEFAULT_ACCOUNT.minTotalRiskBufferMultiplier)
  };
}

async function ensureFtmoGuardianTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ftmo_daily_state (
      date_key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      daily_start_equity REAL NOT NULL,
      daily_start_balance REAL NOT NULL,
      locked INTEGER DEFAULT 0,
      lock_reason TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ftmo_guardian_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      pair TEXT,
      timeframe TEXT,
      signal TEXT,
      allowed INTEGER,
      status TEXT,
      reason TEXT,
      recommended_risk_percent REAL,
      available_new_trade_risk REAL,
      daily_loss_remaining REAL,
      total_loss_remaining REAL,
      source TEXT
    )
  `).run();
}

async function getOrCreateDailyAnchor(db, account, dateKey, timeframe) {
  const existing = await db.prepare(`
    SELECT date_key, daily_start_equity, daily_start_balance, locked, lock_reason
    FROM ftmo_daily_state
    WHERE date_key = ?
    LIMIT 1
  `).bind(dateKey).first();

  if (existing?.date_key) {
    return {
      dateKey: existing.date_key,
      dailyStartEquity: Number(existing.daily_start_equity || account.startingBalance),
      dailyStartBalance: Number(existing.daily_start_balance || account.startingBalance),
      locked: Number(existing.locked || 0),
      lockReason: existing.lock_reason || ""
    };
  }

  const totalClosedPnl = await getTotalClosedPnl(db);
  const openTrades = await getOpenTrades(db, timeframe);
  const valuation = await valueOpenTrades(db, openTrades, timeframe, account);

  const balance = account.startingBalance + totalClosedPnl;
  const equity = balance + valuation.openPnl;

  await db.prepare(`
    INSERT INTO ftmo_daily_state (
      date_key,
      created_at,
      daily_start_equity,
      daily_start_balance,
      locked,
      lock_reason
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    dateKey,
    new Date().toISOString(),
    equity,
    balance,
    0,
    ""
  ).run();

  return {
    dateKey,
    dailyStartEquity: equity,
    dailyStartBalance: balance,
    locked: 0,
    lockReason: ""
  };
}

async function getTotalClosedPnl(db) {
  try {
    const row = await db.prepare(`
      SELECT COALESCE(SUM(pnl), 0) AS total_pnl
      FROM paper_trades
    `).first();

    return Number(row?.total_pnl || 0);
  } catch {
    return 0;
  }
}

async function getClosedStats(db, dateKey) {
  const startIso = `${dateKey}T00:00:00.000`;
  const endIso = `${dateKey}T23:59:59.999`;

  try {
    const row = await db.prepare(`
      SELECT
        COUNT(*) AS closed_trades,
        COALESCE(SUM(pnl), 0) AS realized_pnl,
        SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN win = 0 THEN 1 ELSE 0 END) AS losses
      FROM paper_trades
      WHERE closed_at >= ?
        AND closed_at <= ?
    `).bind(startIso, endIso).first();

    return {
      closedTrades: Number(row?.closed_trades || 0),
      realizedPnl: Number(row?.realized_pnl || 0),
      wins: Number(row?.wins || 0),
      losses: Number(row?.losses || 0)
    };
  } catch {
    return {
      closedTrades: 0,
      realizedPnl: 0,
      wins: 0,
      losses: 0
    };
  }
}

async function getConsecutiveLosses(db) {
  try {
    const res = await db.prepare(`
      SELECT win
      FROM paper_trades
      ORDER BY closed_at DESC
      LIMIT 30
    `).all();

    const rows = Array.isArray(res.results) ? res.results : [];
    let losses = 0;

    for (const row of rows) {
      if (Number(row.win || 0) === 0) losses += 1;
      else break;
    }

    return losses;
  } catch {
    return 0;
  }
}

async function getOpenTrades(db, timeframe) {
  try {
    const res = await db.prepare(`
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
        archive_edge_score,
        setup_type,
        source
      FROM paper_open_trades
      WHERE timeframe = ?
      ORDER BY opened_at DESC
    `).bind(timeframe).all();

    return Array.isArray(res.results)
      ? res.results.map((row) => ({
        id: row.id,
        pair: String(row.pair || "").toUpperCase(),
        timeframe: normalizeTimeframe(row.timeframe) || timeframe,
        direction: String(row.direction || "buy").toLowerCase(),
        openedAt: row.opened_at,
        entry: Number(row.entry || 0),
        stopLoss: Number(row.stop_loss || 0),
        takeProfit: Number(row.take_profit || 0),
        currentPrice: Number(row.current_price || row.entry || 0),
        riskPercent: Number(row.risk_percent || 0),
        rr: Number(row.rr || 1.35),
        barsHeld: Number(row.bars_held || 0),
        maxBarsHold: Number(row.max_bars_hold || 0),
        ultraScore: Number(row.ultra_score || 0),
        archiveEdgeScore: Number(row.archive_edge_score || 50),
        setupType: row.setup_type || "unknown",
        source: row.source || "server-paper"
      }))
      : [];
  } catch {
    return [];
  }
}

async function valueOpenTrades(db, openTrades, timeframe, account) {
  const valuedTrades = [];
  let openPnl = 0;
  let openRisk = 0;

  for (const trade of openTrades || []) {
    const current = await getCurrentPrice(db, trade.pair, timeframe);
    const price = current || Number(trade.currentPrice || trade.entry || 0);

    const riskDistance = Math.abs(Number(trade.entry || 0) - Number(trade.stopLoss || 0));
    const liveDistance =
      trade.direction === "sell"
        ? Number(trade.entry || 0) - price
        : price - Number(trade.entry || 0);

    const pnlR = riskDistance > 0 ? liveDistance / riskDistance : 0;
    const riskAmount = Math.max(0, account.startingBalance * (Number(trade.riskPercent || 0) / 100));
    const pnl = pnlR * riskAmount;

    openPnl += pnl;
    openRisk += riskAmount;

    valuedTrades.push({
      id: trade.id,
      pair: trade.pair,
      timeframe: trade.timeframe,
      direction: trade.direction,
      entry: roundByPair(trade.entry, trade.pair),
      current: roundByPair(price, trade.pair),
      stopLoss: roundByPair(trade.stopLoss, trade.pair),
      takeProfit: roundByPair(trade.takeProfit, trade.pair),
      riskPercent: round(trade.riskPercent, 3),
      riskAmount: round(riskAmount, 2),
      pnlR: round(pnlR, 3),
      pnl: round(pnl, 2),
      setupType: trade.setupType,
      ultraScore: trade.ultraScore,
      archiveEdgeScore: trade.archiveEdgeScore
    });
  }

  return {
    openPnl,
    openRisk,
    valuedTrades
  };
}

async function getCurrentPrice(db, pair, timeframe) {
  try {
    const row = await db.prepare(`
      SELECT close
      FROM market_candles
      WHERE pair = ?
        AND timeframe = ?
      ORDER BY ts DESC
      LIMIT 1
    `).bind(pair, timeframe).first();

    return Number(row?.close || 0);
  } catch {
    return 0;
  }
}

function normalizeCandidate(scan, account) {
  const riskPercent = Number(
    scan?.ftmoRecommendedRiskPercent ||
    scan?.riskPercent ||
    scan?.computedRiskPercent ||
    estimateRiskPercentFromScore(scan, account)
  );

  return {
    pair: String(scan?.pair || "").toUpperCase(),
    timeframe: normalizeTimeframe(scan?.timeframe) || "M15",
    direction: String(scan?.direction || "").toLowerCase(),
    signal: String(scan?.signal || "WAIT").toUpperCase(),
    riskPercent,
    riskAmount: account.startingBalance * (riskPercent / 100)
  };
}

function estimateRiskPercentFromScore(scan, account) {
  const ultra = Number(scan?.ultraScore || 0);
  const entry = Number(scan?.entryQualityScore || 0);
  const setup = Number(scan?.setupQualityScore || 0);
  const exitPressure = Number(scan?.exitPressureScore || 99);
  const historical = Number(scan?.historicalEdgeScore || scan?.archiveEdgeScore || 50);

  let risk = 0.12;

  if (ultra >= 72 && entry >= 68 && setup >= 66) risk = 0.18;
  if (ultra >= 82 && entry >= 76 && setup >= 74 && historical >= 56) risk = 0.25;
  if (ultra >= 88 && entry >= 82 && setup >= 80 && historical >= 64) risk = 0.32;

  if (exitPressure >= 64) risk *= 0.65;
  if (scan?.pair === "XAUUSD") risk *= 0.82;
  if (scan?.pair === "BTCUSD") risk *= 0.6;
  if (scan?.lateImpulse) risk *= 0.35;
  if (scan?.volatilityRegime === "elevated") risk *= 0.7;
  if (scan?.volatilityRegime === "extreme") risk = 0;

  return Math.min(account.maxTradeRiskPercent, Math.max(0, risk));
}

function computeGuardianRiskPercent(data) {
  const account = data.account;
  const context = data.context;
  const scan = data.scan || {};
  const warnings = data.warnings || [];

  if (context.status.locked) return 0;

  let risk = account.maxTradeRiskPercent;

  risk = Math.min(risk, percentOf(context.availableNewTradeRisk, account.startingBalance));

  const ultra = Number(scan.ultraScore || 0);
  const entry = Number(scan.entryQualityScore || 0);
  const setup = Number(scan.setupQualityScore || 0);
  const historical = Number(scan.historicalEdgeScore || scan.archiveEdgeScore || 50);
  const exitPressure = Number(scan.exitPressureScore || 99);

  if (ultra < 72 || entry < 68 || setup < 66) risk = Math.min(risk, 0.12);
  if (ultra >= 82 && entry >= 76 && setup >= 74 && historical >= 56) risk = Math.min(risk, 0.25);
  if (ultra >= 88 && entry >= 82 && setup >= 80 && historical >= 64 && exitPressure < 42) risk = Math.min(risk, 0.32);

  if (context.status.level === "danger") risk = Math.min(risk, 0.05);
  if (context.status.level === "caution") risk = Math.min(risk, 0.12);

  if (context.dailyLosses >= 1) risk = Math.min(risk, 0.12);
  if (context.consecutiveLosses >= 1) risk = Math.min(risk, 0.12);

  if (context.dailyLossRemaining < account.startingBalance * 0.0125) risk = Math.min(risk, 0.08);
  if (context.totalLossRemaining < account.startingBalance * 0.025) risk = Math.min(risk, 0.08);

  if (scan.pair === "XAUUSD") risk *= 0.82;
  if (scan.pair === "BTCUSD") risk *= 0.6;

  if (scan.volatilityRegime === "elevated") risk *= 0.72;
  if (scan.volatilityRegime === "extreme") risk = 0;
  if (scan.lateImpulse) risk = 0;
  if (exitPressure >= 72) risk = 0;

  if (warnings.length >= 2) risk *= 0.65;

  return Math.max(0, Math.min(account.maxTradeRiskPercent, risk));
}

function computeStatus(data) {
  if (data.dailyLossRemainingPercent <= 0) {
    return {
      level: "locked",
      label: "LOCKED",
      locked: true,
      reason: "Daily loss limit reached."
    };
  }

  if (data.totalLossRemainingPercent <= 0) {
    return {
      level: "locked",
      label: "LOCKED",
      locked: true,
      reason: "Maximum loss limit reached."
    };
  }

  if (data.dailyLosses >= data.account.maxDailyLosses) {
    return {
      level: "locked",
      label: "LOCKED",
      locked: true,
      reason: "Daily loss count reached."
    };
  }

  if (data.consecutiveLosses >= data.account.maxConsecutiveLosses) {
    return {
      level: "locked",
      label: "LOCKED",
      locked: true,
      reason: "Consecutive loss limit reached."
    };
  }

  if (data.dailyTrades >= data.account.maxDailyTrades) {
    return {
      level: "locked",
      label: "LOCKED",
      locked: true,
      reason: "Daily trade limit reached."
    };
  }

  if (data.availableNewTradeRisk <= 0) {
    return {
      level: "locked",
      label: "LOCKED",
      locked: true,
      reason: "No available risk budget."
    };
  }

  if (
    data.dailyLossRemainingPercent <= data.account.dangerDailyBufferPercent ||
    data.totalLossRemainingPercent <= 1.5
  ) {
    return {
      level: "danger",
      label: "DANGER",
      locked: false,
      reason: "Very low drawdown buffer."
    };
  }

  if (
    data.dailyLossRemainingPercent <= data.account.cautionDailyBufferPercent ||
    data.totalLossRemainingPercent <= 2.5
  ) {
    return {
      level: "caution",
      label: "CAUTION",
      locked: false,
      reason: "Reduced drawdown buffer."
    };
  }

  return {
    level: "safe",
    label: "SAFE",
    locked: false,
    reason: "Account is inside FTMO risk limits."
  };
}

function buildCurrencyExposure(valuedTrades) {
  const exposure = {};

  for (const trade of valuedTrades || []) {
    for (const group of getPairRiskGroups(trade.pair)) {
      if (!exposure[group]) {
        exposure[group] = {
          trades: 0,
          riskAmount: 0,
          openPnl: 0,
          pairs: []
        };
      }

      exposure[group].trades += 1;
      exposure[group].riskAmount += Number(trade.riskAmount || 0);
      exposure[group].openPnl += Number(trade.pnl || 0);
      exposure[group].pairs.push(trade.pair);
    }
  }

  for (const key of Object.keys(exposure)) {
    exposure[key].riskAmount = round(exposure[key].riskAmount, 2);
    exposure[key].openPnl = round(exposure[key].openPnl, 2);
    exposure[key].pairs = [...new Set(exposure[key].pairs)];
  }

  return exposure;
}

function computeCandidateExposure(currentExposure, trade) {
  const groupTrades = {};

  for (const [group, item] of Object.entries(currentExposure || {})) {
    groupTrades[group] = Number(item.trades || 0);
  }

  for (const group of getPairRiskGroups(trade.pair)) {
    groupTrades[group] = (groupTrades[group] || 0) + 1;
  }

  return {
    groupTrades,
    usdTrades: Number(groupTrades.USD || 0)
  };
}

function buildAllowedReason(context, trade, recommendedRiskPercent, warnings) {
  const parts = [
    `FTMO allowed`,
    `risk ${round(recommendedRiskPercent, 3)}%`,
    `available ${money(context.availableNewTradeRisk)}`,
    `daily buffer ${money(context.dailyLossRemaining)}`,
    `total buffer ${money(context.totalLossRemaining)}`
  ];

  if (warnings.length) {
    parts.push(`warnings: ${warnings.join(" / ")}`);
  }

  return parts.join(" · ");
}

function getPairRiskGroups(pair) {
  const p = String(pair || "").toUpperCase();
  const groups = [];

  if (p.includes("USD")) groups.push("USD");
  if (p.includes("EUR")) groups.push("EUR");
  if (p.includes("GBP")) groups.push("GBP");
  if (p.includes("JPY")) groups.push("JPY");
  if (p.includes("AUD") || p.includes("NZD")) groups.push("AUD_NZD");
  if (p === "XAUUSD") groups.push("GOLD_USD");
  if (p === "BTCUSD") groups.push("BTC_USD");

  return [...new Set(groups)];
}

function getPhaseDefaults(phase) {
  if (phase === "verification") {
    return {
      profitTargetPercent: 5
    };
  }

  if (phase === "funded") {
    return {
      profitTargetPercent: 0
    };
  }

  return {
    profitTargetPercent: 10
  };
}

function readNumber(primary, secondary, fallback) {
  const raw = primary ?? secondary ?? fallback;
  const n = Number(raw);

  return Number.isFinite(n) ? n : fallback;
}

function getParisDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value || "1970";
  const month = parts.find((part) => part.type === "month")?.value || "01";
  const day = parts.find((part) => part.type === "day")?.value || "01";

  return `${year}-${month}-${day}`;
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

function roundByPair(value, pair) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  const p = String(pair || "").toUpperCase();

  if (p === "XAUUSD" || p === "BTCUSD") return Number(n.toFixed(2));
  if (p.includes("JPY")) return Number(n.toFixed(3));

  return Number(n.toFixed(5));
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Number(n.toFixed(digits));
}

function money(value) {
  return `${round(value, 2)}`;
}
