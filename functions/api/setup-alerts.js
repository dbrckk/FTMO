const MODEL_VERSION = "setup-alerts-v4-ai-rules-ftmo-telegram";

const DEFAULT_TIMEFRAME = "M15";

const DEFAULT_CONFIG = {
  minPaperScore: 78,
  minUltraScore: 74,
  minEntryQuality: 70,
  minSetupQuality: 68,
  maxExitPressure: 64,
  cooldownMinutes: 90,
  maxAlertsPerRun: 3,
  maxAlertsPerPairPerDay: 3,
  analyticsMinTrades: 8
};

export async function onRequestGet(context) {
  return handleSetupAlerts(context);
}

export async function onRequestPost(context) {
  return handleSetupAlerts(context);
}

async function handleSetupAlerts(context) {
  const startedAt = Date.now();

  try {
    const env = context.env || {};
    const db = env.DB;

    if (!db) {
      return json({
        ok: false,
        source: "setup-alerts",
        version: MODEL_VERSION,
        error: "Missing DB binding"
      }, 500);
    }

    if (!isAuthorized(context.request, env.SYNC_SECRET || "")) {
      return json({
        ok: false,
        source: "setup-alerts",
        version: MODEL_VERSION,
        error: "Unauthorized"
      }, 401);
    }

    await ensureAlertTables(db);

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    const config = buildConfig(env, url, body);

    const dryRun = readBool(url, body, "dryRun", false);
    const force = readBool(url, body, "force", false) || readBool(url, body, "forceAlerts", false);
    const refreshAnalytics = readBool(url, body, "refreshAnalytics", true);
    const sendTelegram = readBool(url, body, "telegram", true) && readBool(url, body, "alerts", true);

    const timeframes = parseTimeframes(
      url.searchParams.get("timeframes") ||
      url.searchParams.get("timeframe") ||
      body.timeframes ||
      body.timeframe ||
      DEFAULT_TIMEFRAME
    );

    const origin = new URL(context.request.url).origin;
    const syncSecret = env.SYNC_SECRET || "";

    const analytics = refreshAnalytics
      ? await refreshAnalyticsEngine(origin, syncSecret, config)
      : { ok: true, skipped: true };

    const scanResponses = [];

    for (const timeframe of timeframes) {
      const scanResponse = await getPaperRunCandidates(origin, syncSecret, timeframe);
      scanResponses.push(scanResponse);
    }

    const allCandidates = scanResponses.flatMap((response) =>
      Array.isArray(response.topCandidates)
        ? response.topCandidates.map((candidate) => ({
          ...candidate,
          timeframe: candidate.timeframe || response.timeframe || DEFAULT_TIMEFRAME
        }))
        : []
    );

    const ranked = rankCandidates(allCandidates, config);
    const eligible = [];

    for (const candidate of ranked) {
      const gate = await buildAlertGate(db, candidate, config, {
        force
      });

      eligible.push({
        ...candidate,
        alertGate: gate
      });
    }

    const selected = eligible
      .filter((candidate) => candidate.alertGate.allowed)
      .slice(0, config.maxAlertsPerRun);

    const sent = [];
    const skipped = eligible
      .filter((candidate) => !candidate.alertGate.allowed)
      .slice(0, 30)
      .map((candidate) => ({
        pair: candidate.pair,
        timeframe: candidate.timeframe,
        direction: candidate.direction,
        paperScore: candidate.paperScore,
        reason: candidate.alertGate.reason
      }));

    for (const candidate of selected) {
      const message = buildTelegramMessage(candidate, {
        dryRun
      });

      let telegramResult = {
        ok: false,
        skipped: true,
        reason: "telegram-disabled"
      };

      if (!dryRun && sendTelegram) {
        telegramResult = await sendTelegramMessage(env, message);
      }

      await insertAlertEvent(db, candidate, {
        dryRun,
        telegramOk: Boolean(telegramResult.ok),
        telegramSkipped: Boolean(telegramResult.skipped),
        message,
        reason: candidate.alertGate.reason
      });

      sent.push({
        pair: candidate.pair,
        timeframe: candidate.timeframe,
        direction: candidate.direction,
        setupType: candidate.setupType,
        paperScore: candidate.paperScore,
        ultraScore: candidate.ultraScore,
        entryQualityScore: candidate.entryQualityScore,
        ftmoStatus: candidate.ftmoStatus,
        ftmoRisk: candidate.ftmoRecommendedRiskPercent,
        newsRiskLevel: candidate.newsRiskLevel,
        modelRulesApplied: candidate.modelRulesApplied || 0,
        modelRulesScoreDelta: candidate.modelRulesScoreDelta || 0,
        telegram: sanitizeTelegramResult(telegramResult)
      });
    }

    const summary = {
      scanned: allCandidates.length,
      eligible: selected.length,
      sent: sent.filter((item) => item.telegram.ok).length,
      dryRun,
      force,
      telegramEnabled: sendTelegram,
      analyticsRefreshed: analytics.ok === true && !analytics.skipped,
      timeframes
    };

    if (!dryRun && sendTelegram && selected.length === 0 && readBool(url, body, "notifyNoSetup", false)) {
      const noSetupMessage = buildNoSetupMessage({
        ranked,
        skipped,
        timeframes
      });

      const telegramResult = await sendTelegramMessage(env, noSetupMessage);

      summary.noSetupTelegram = sanitizeTelegramResult(telegramResult);
    }

    return json({
      ok: true,
      source: "setup-alerts",
      version: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      config: {
        minPaperScore: config.minPaperScore,
        minUltraScore: config.minUltraScore,
        minEntryQuality: config.minEntryQuality,
        minSetupQuality: config.minSetupQuality,
        maxExitPressure: config.maxExitPressure,
        cooldownMinutes: config.cooldownMinutes,
        maxAlertsPerRun: config.maxAlertsPerRun,
        maxAlertsPerPairPerDay: config.maxAlertsPerPairPerDay
      },
      summary,
      analytics: summarizeAnalytics(analytics),
      scanResponses: scanResponses.map((response) => ({
        ok: response.ok,
        timeframe: response.timeframe,
        scannedPairs: response.scannedPairs,
        topCandidates: Array.isArray(response.topCandidates) ? response.topCandidates.length : 0,
        version: response.version,
        error: response.error || null
      })),
      sent,
      bestCandidates: ranked.slice(0, 12).map(publicCandidate),
      skipped
    });
  } catch (error) {
    return json({
      ok: false,
      source: "setup-alerts",
      version: MODEL_VERSION,
      error: String(error?.message || error || "setup-alerts-error")
    }, 500);
  }
}

async function ensureAlertTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS setup_alerts (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      pair TEXT,
      timeframe TEXT,
      direction TEXT,
      setup_type TEXT,
      paper_score REAL,
      ultra_score REAL,
      entry_quality_score REAL,
      setup_quality_score REAL,
      exit_pressure_score REAL,
      ftmo_status TEXT,
      ftmo_risk_percent REAL,
      news_risk_level TEXT,
      model_rules_applied INTEGER,
      model_rules_score_delta REAL,
      dry_run INTEGER,
      telegram_ok INTEGER,
      telegram_skipped INTEGER,
      reason TEXT,
      message TEXT,
      payload_json TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS alert_cooldowns (
      id TEXT PRIMARY KEY,
      pair TEXT,
      timeframe TEXT,
      direction TEXT,
      setup_type TEXT,
      last_alert_at TEXT NOT NULL,
      alert_count INTEGER,
      payload_json TEXT
    )
  `).run();
}

async function refreshAnalyticsEngine(origin, syncSecret, config) {
  try {
    const url = new URL(`${origin}/api/analytics-engine`);
    if (syncSecret) url.searchParams.set("token", syncSecret);
    url.searchParams.set("minTrades", String(config.analyticsMinTrades));

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json"
      }
    });

    const data = await safeResponseJson(response);

    return {
      ok: response.ok && data.ok !== false,
      status: response.status,
      ...data
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || "analytics-refresh-error")
    };
  }
}

async function getPaperRunCandidates(origin, syncSecret, timeframe) {
  try {
    const url = new URL(`${origin}/api/paper-run`);
    if (syncSecret) url.searchParams.set("token", syncSecret);
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("dryRun", "1");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json"
      }
    });

    const data = await safeResponseJson(response);

    return {
      ok: response.ok && data.ok !== false,
      status: response.status,
      timeframe,
      ...data
    };
  } catch (error) {
    return {
      ok: false,
      timeframe,
      error: String(error?.message || error || "paper-run-fetch-error"),
      topCandidates: []
    };
  }
}

function rankCandidates(candidates, config) {
  return candidates
    .filter(Boolean)
    .map((candidate) => normalizeCandidate(candidate))
    .map((candidate) => ({
      ...candidate,
      alertScore: computeAlertScore(candidate)
    }))
    .filter((candidate) => candidate.direction === "buy" || candidate.direction === "sell")
    .filter((candidate) => candidate.signal === "BUY" || candidate.signal === "SELL")
    .filter((candidate) => candidate.tradeAllowed !== false)
    .filter((candidate) => candidate.newsAllowed !== false)
    .filter((candidate) => candidate.ftmoAllowed !== false)
    .filter((candidate) => Number(candidate.paperScore || 0) >= config.minPaperScore)
    .filter((candidate) => Number(candidate.ultraScore || 0) >= config.minUltraScore)
    .filter((candidate) => Number(candidate.entryQualityScore || 0) >= config.minEntryQuality)
    .filter((candidate) => Number(candidate.setupQualityScore || 0) >= config.minSetupQuality)
    .filter((candidate) => Number(candidate.exitPressureScore || 99) <= config.maxExitPressure)
    .sort((a, b) => Number(b.alertScore || 0) - Number(a.alertScore || 0));
}

function normalizeCandidate(candidate) {
  return {
    ...candidate,
    pair: normalizePair(candidate.pair),
    timeframe: normalizeTimeframe(candidate.timeframe) || DEFAULT_TIMEFRAME,
    direction: String(candidate.direction || "").toLowerCase(),
    signal: String(candidate.signal || "").toUpperCase(),

    current: Number(candidate.current || 0),
    stopLoss: Number(candidate.stopLoss || 0),
    takeProfit: Number(candidate.takeProfit || 0),
    tp1: Number(candidate.tp1 || 0),
    rr: Number(candidate.rr || 0),

    paperScore: Number(candidate.paperScore || 0),
    ultraScore: Number(candidate.ultraScore || 0),
    trendScore: Number(candidate.trendScore || 0),
    timingScore: Number(candidate.timingScore || 0),
    riskScore: Number(candidate.riskScore || 0),
    executionScore: Number(candidate.executionScore || 0),
    smartMoneyScore: Number(candidate.smartMoneyScore || 0),
    entryQualityScore: Number(candidate.entryQualityScore || 0),
    setupQualityScore: Number(candidate.setupQualityScore || 0),
    exitPressureScore: Number(candidate.exitPressureScore || 99),

    historicalEdgeScore: Number(candidate.historicalEdgeScore || candidate.archiveEdgeScore || 50),
    historicalConfidence: Number(candidate.historicalConfidence || 0),

    setupType: String(candidate.setupType || "unknown"),
    setupLabel: String(candidate.setupLabel || candidate.setupType || "Unknown setup"),
    volatilityRegime: String(candidate.volatilityRegime || "unknown"),
    trendRegime: String(candidate.trendRegime || "unknown"),

    ftmoRecommendedRiskPercent: Number(candidate.ftmoRecommendedRiskPercent || 0),
    ftmoRecommendedRiskAmount: Number(candidate.ftmoRecommendedRiskAmount || 0),

    modelRulesApplied: Number(candidate.modelRulesApplied || 0),
    modelRulesScoreDelta: Number(candidate.modelRulesScoreDelta || 0),
    modelRulesReasons: Array.isArray(candidate.modelRulesReasons) ? candidate.modelRulesReasons : []
  };
}

async function buildAlertGate(db, candidate, config, options = {}) {
  if (options.force) {
    return {
      allowed: true,
      reason: "force-alert"
    };
  }

  const key = buildCooldownKey(candidate);
  const cooldown = await getCooldown(db, key);

  if (cooldown) {
    const minutesSince = minutesBetween(new Date(cooldown.last_alert_at), new Date());

    if (minutesSince < config.cooldownMinutes) {
      return {
        allowed: false,
        reason: `cooldown-active-${Math.round(config.cooldownMinutes - minutesSince)}min`
      };
    }
  }

  const dayCount = await countAlertsToday(db, candidate);

  if (dayCount >= config.maxAlertsPerPairPerDay) {
    return {
      allowed: false,
      reason: `daily-pair-alert-limit-${dayCount}`
    };
  }

  if (candidate.modelRulesApplied > 0 && candidate.modelRulesScoreDelta <= -12) {
    return {
      allowed: false,
      reason: "model-rules-heavy-penalty"
    };
  }

  if (candidate.ftmoStatus && ["LOCKED", "DANGER", "BLOCKED"].includes(String(candidate.ftmoStatus).toUpperCase())) {
    return {
      allowed: false,
      reason: `ftmo-${candidate.ftmoStatus}`
    };
  }

  if (String(candidate.newsRiskLevel || "").toUpperCase() === "HIGH") {
    return {
      allowed: false,
      reason: "high-news-risk"
    };
  }

  return {
    allowed: true,
    reason: "eligible"
  };
}

async function getCooldown(db, key) {
  try {
    return await db.prepare(`
      SELECT *
      FROM alert_cooldowns
      WHERE id = ?
      LIMIT 1
    `).bind(key).first();
  } catch {
    return null;
  }
}

async function countAlertsToday(db, candidate) {
  try {
    const start = startOfParisDayIso();

    const row = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM setup_alerts
      WHERE created_at >= ?
        AND pair = ?
        AND timeframe = ?
        AND dry_run = 0
    `).bind(
      start,
      candidate.pair,
      candidate.timeframe
    ).first();

    return Number(row?.count || 0);
  } catch {
    return 0;
  }
}

async function insertAlertEvent(db, candidate, meta) {
  const now = new Date().toISOString();
  const id = `alert_${Date.now()}_${candidate.pair}_${candidate.timeframe}_${Math.random().toString(36).slice(2, 8)}`;
  const cooldownKey = buildCooldownKey(candidate);

  await db.prepare(`
    INSERT INTO setup_alerts (
      id,
      created_at,
      pair,
      timeframe,
      direction,
      setup_type,
      paper_score,
      ultra_score,
      entry_quality_score,
      setup_quality_score,
      exit_pressure_score,
      ftmo_status,
      ftmo_risk_percent,
      news_risk_level,
      model_rules_applied,
      model_rules_score_delta,
      dry_run,
      telegram_ok,
      telegram_skipped,
      reason,
      message,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    now,
    candidate.pair,
    candidate.timeframe,
    candidate.direction,
    candidate.setupType,
    Number(candidate.paperScore || 0),
    Number(candidate.ultraScore || 0),
    Number(candidate.entryQualityScore || 0),
    Number(candidate.setupQualityScore || 0),
    Number(candidate.exitPressureScore || 0),
    candidate.ftmoStatus || "",
    Number(candidate.ftmoRecommendedRiskPercent || 0),
    candidate.newsRiskLevel || "",
    Number(candidate.modelRulesApplied || 0),
    Number(candidate.modelRulesScoreDelta || 0),
    meta.dryRun ? 1 : 0,
    meta.telegramOk ? 1 : 0,
    meta.telegramSkipped ? 1 : 0,
    meta.reason || "",
    meta.message || "",
    JSON.stringify(candidate)
  ).run();

  if (!meta.dryRun) {
    const previous = await getCooldown(db, cooldownKey);
    const nextCount = Number(previous?.alert_count || 0) + 1;

    await db.prepare(`
      INSERT OR REPLACE INTO alert_cooldowns (
        id,
        pair,
        timeframe,
        direction,
        setup_type,
        last_alert_at,
        alert_count,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      cooldownKey,
      candidate.pair,
      candidate.timeframe,
      candidate.direction,
      candidate.setupType,
      now,
      nextCount,
      JSON.stringify(candidate)
    ).run();
  }

  return id;
}

async function sendTelegramMessage(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || "";
  const chatId = env.TELEGRAM_CHAT_ID || env.CHAT_ID || "";

  if (!token || !chatId) {
    return {
      ok: false,
      skipped: true,
      reason: "missing-telegram-env"
    };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });

    const data = await safeResponseJson(response);

    return {
      ok: response.ok && data.ok !== false,
      status: response.status,
      result: data.ok === true ? "sent" : "telegram-error",
      description: data.description || ""
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: String(error?.message || error || "telegram-error")
    };
  }
}

function buildTelegramMessage(candidate, options = {}) {
  const directionIcon = candidate.direction === "buy" ? "🟢" : "🔴";
  const dryPrefix = options.dryRun ? "🧪 DRY RUN\n" : "";

  const risk = Number(candidate.ftmoRecommendedRiskPercent || 0) > 0
    ? `${round(candidate.ftmoRecommendedRiskPercent, 2)}%`
    : "auto";

  const current = formatPrice(candidate.current, candidate.pair);
  const sl = formatPrice(candidate.stopLoss, candidate.pair);
  const tp = formatPrice(candidate.takeProfit, candidate.pair);
  const tp1 = formatPrice(candidate.tp1, candidate.pair);

  const modelDelta = Number(candidate.modelRulesScoreDelta || 0);
  const modelLine = candidate.modelRulesApplied > 0
    ? `\n🧠 IA rules: ${candidate.modelRulesApplied} | delta ${modelDelta > 0 ? "+" : ""}${round(modelDelta, 1)}`
    : "";

  const newsLine = candidate.newsRiskLevel
    ? `\n📰 News: ${escapeHtml(String(candidate.newsRiskLevel).toUpperCase())} — ${escapeHtml(candidate.newsReason || "clear")}`
    : "";

  const ftmoLine = candidate.ftmoStatus
    ? `\n🛡️ FTMO: ${escapeHtml(candidate.ftmoStatus)} | risk ${escapeHtml(risk)}`
    : `\n🛡️ Risk: ${escapeHtml(risk)}`;

  const reason = cleanReason(candidate.tradeReason || candidate.ftmoReason || "Setup validé.");

  return `${dryPrefix}${directionIcon} <b>${escapeHtml(candidate.pair)} ${escapeHtml(candidate.direction.toUpperCase())}</b> — ${escapeHtml(candidate.timeframe)}

🎯 Setup: <b>${escapeHtml(candidate.setupLabel || candidate.setupType)}</b>
⭐ Alert score: <b>${round(candidate.alertScore, 1)}/100</b>
📊 Paper: ${round(candidate.paperScore, 0)} | Ultra: ${round(candidate.ultraScore, 0)} | Entry: ${round(candidate.entryQualityScore, 0)}
⚙️ SetupQ: ${round(candidate.setupQualityScore, 0)} | ExitPressure: ${round(candidate.exitPressureScore, 0)}
📈 Trend: ${escapeHtml(candidate.trendRegime)} | Vol: ${escapeHtml(candidate.volatilityRegime)}
${ftmoLine}${newsLine}${modelLine}

📍 Entry: <code>${escapeHtml(current)}</code>
🛑 SL: <code>${escapeHtml(sl)}</code>
🎯 TP1: <code>${escapeHtml(tp1)}</code>
🏁 TP: <code>${escapeHtml(tp)}</code>
⚖️ RR: <b>${round(candidate.rr, 2)}</b>

✅ Raison: ${escapeHtml(reason)}

Plan:
1) Entrée uniquement si le prix reste proche de la zone.
2) Break-even vers +0.65R.
3) Trail vers +1.05R.
4) Skip si news forte ou impulsion déjà trop tardive.`;
}

function buildNoSetupMessage(data) {
  const best = Array.isArray(data.ranked) ? data.ranked.slice(0, 5) : [];
  const lines = best.map((candidate, index) =>
    `${index + 1}. ${candidate.pair} ${candidate.direction?.toUpperCase?.() || ""} | score ${round(candidate.paperScore, 0)} | ${candidate.tradeReason || "blocked"}`
  );

  return `⚪ <b>No high-quality setup found</b>

Timeframes: ${escapeHtml(data.timeframes.join(", "))}

Best blocked candidates:
${escapeHtml(lines.join("\n") || "none")}

Action: wait. No forced trade.`;
}

function computeAlertScore(candidate) {
  let score = 0;

  score += Number(candidate.paperScore || 0) * 0.28;
  score += Number(candidate.ultraScore || 0) * 0.18;
  score += Number(candidate.entryQualityScore || 0) * 0.18;
  score += Number(candidate.setupQualityScore || 0) * 0.14;
  score += Number(candidate.historicalEdgeScore || 50) * 0.08;
  score += Number(candidate.riskScore || 50) * 0.05;
  score += Number(candidate.executionScore || 50) * 0.05;
  score += (100 - Number(candidate.exitPressureScore || 50)) * 0.04;

  if (candidate.setupType === "trend-pullback") score += 4;
  if (candidate.setupType === "breakout-continuation") score += 2;
  if (candidate.setupType === "liquidity-rejection") score += 2;
  if (candidate.volatilityRegime === "normal") score += 2;
  if (candidate.volatilityRegime === "elevated") score -= 4;
  if (candidate.volatilityRegime === "extreme") score -= 12;
  if (candidate.newsRiskLevel && String(candidate.newsRiskLevel).toUpperCase() !== "CLEAR") score -= 3;
  if (candidate.ftmoStatus && String(candidate.ftmoStatus).toUpperCase() === "CAUTION") score -= 4;
  if (candidate.modelRulesApplied > 0) score += Number(candidate.modelRulesScoreDelta || 0) * 0.8;

  return clamp(score, 0, 100);
}

function buildConfig(env, url, body) {
  return {
    minPaperScore: Number(url.searchParams.get("minPaperScore") || body.minPaperScore || env.ALERT_MIN_PAPER_SCORE || DEFAULT_CONFIG.minPaperScore),
    minUltraScore: Number(url.searchParams.get("minUltraScore") || body.minUltraScore || env.ALERT_MIN_ULTRA_SCORE || DEFAULT_CONFIG.minUltraScore),
    minEntryQuality: Number(url.searchParams.get("minEntryQuality") || body.minEntryQuality || env.ALERT_MIN_ENTRY_QUALITY || DEFAULT_CONFIG.minEntryQuality),
    minSetupQuality: Number(url.searchParams.get("minSetupQuality") || body.minSetupQuality || env.ALERT_MIN_SETUP_QUALITY || DEFAULT_CONFIG.minSetupQuality),
    maxExitPressure: Number(url.searchParams.get("maxExitPressure") || body.maxExitPressure || env.ALERT_MAX_EXIT_PRESSURE || DEFAULT_CONFIG.maxExitPressure),
    cooldownMinutes: Number(url.searchParams.get("cooldownMinutes") || body.cooldownMinutes || env.ALERT_COOLDOWN_MINUTES || DEFAULT_CONFIG.cooldownMinutes),
    maxAlertsPerRun: Number(url.searchParams.get("maxAlertsPerRun") || body.maxAlertsPerRun || env.ALERT_MAX_PER_RUN || DEFAULT_CONFIG.maxAlertsPerRun),
    maxAlertsPerPairPerDay: Number(url.searchParams.get("maxAlertsPerPairPerDay") || body.maxAlertsPerPairPerDay || env.ALERT_MAX_PER_PAIR_PER_DAY || DEFAULT_CONFIG.maxAlertsPerPairPerDay),
    analyticsMinTrades: Number(url.searchParams.get("analyticsMinTrades") || body.analyticsMinTrades || env.ANALYTICS_MIN_TRADES || DEFAULT_CONFIG.analyticsMinTrades)
  };
}

function parseTimeframes(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || DEFAULT_TIMEFRAME);

  const timeframes = raw
    .split(",")
    .map((item) => normalizeTimeframe(item))
    .filter(Boolean);

  return [...new Set(timeframes.length ? timeframes : [DEFAULT_TIMEFRAME])];
}

function publicCandidate(candidate) {
  return {
    pair: candidate.pair,
    timeframe: candidate.timeframe,
    signal: candidate.signal,
    direction: candidate.direction,
    setupType: candidate.setupType,
    setupLabel: candidate.setupLabel,
    current: candidate.current,
    stopLoss: candidate.stopLoss,
    takeProfit: candidate.takeProfit,
    tp1: candidate.tp1,
    rr: candidate.rr,
    alertScore: round(candidate.alertScore, 1),
    paperScore: candidate.paperScore,
    ultraScore: candidate.ultraScore,
    entryQualityScore: candidate.entryQualityScore,
    setupQualityScore: candidate.setupQualityScore,
    exitPressureScore: candidate.exitPressureScore,
    ftmoStatus: candidate.ftmoStatus,
    ftmoRecommendedRiskPercent: candidate.ftmoRecommendedRiskPercent,
    newsRiskLevel: candidate.newsRiskLevel,
    modelRulesApplied: candidate.modelRulesApplied,
    modelRulesScoreDelta: candidate.modelRulesScoreDelta,
    tradeAllowed: candidate.tradeAllowed,
    tradeReason: candidate.tradeReason
  };
}

function summarizeAnalytics(analytics) {
  return {
    ok: analytics.ok === true,
    skipped: analytics.skipped === true,
    status: analytics.status || null,
    source: analytics.source || null,
    version: analytics.version || null,
    overall: analytics.overall || null,
    recommendations: analytics.recommendations
      ? {
        count: Array.isArray(analytics.recommendations.rules)
          ? analytics.recommendations.rules.length
          : 0
      }
      : null,
    error: analytics.error || null
  };
}

function sanitizeTelegramResult(result) {
  return {
    ok: Boolean(result?.ok),
    skipped: Boolean(result?.skipped),
    status: result?.status || null,
    result: result?.result || null,
    reason: result?.reason || null,
    description: result?.description || null,
    error: result?.error || null
  };
}

function buildCooldownKey(candidate) {
  return [
    normalizePair(candidate.pair),
    normalizeTimeframe(candidate.timeframe) || DEFAULT_TIMEFRAME,
    String(candidate.direction || "").toLowerCase(),
    String(candidate.setupType || "unknown").toLowerCase()
  ].join("_");
}

function startOfParisDayIso() {
  const now = new Date();

  const parisParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const year = parisParts.find((part) => part.type === "year")?.value;
  const month = parisParts.find((part) => part.type === "month")?.value;
  const day = parisParts.find((part) => part.type === "day")?.value;

  return new Date(`${year}-${month}-${day}T00:00:00+01:00`).toISOString();
}

function minutesBetween(a, b) {
  const start = new Date(a).getTime();
  const end = new Date(b).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 999999;

  return Math.max(0, (end - start) / 60000);
}

async function safeResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
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

function isAuthorized(request, secret) {
  if (!secret) return true;

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  return token === secret || bearer === secret;
}

function normalizePair(value) {
  return String(value || "")
    .toUpperCase()
    .replaceAll(".", "")
    .replaceAll("_", "")
    .replaceAll("-", "")
    .trim();
}

function normalizeTimeframe(value) {
  const tf = String(value || "").toUpperCase().trim();

  return ["M5", "M15", "H1", "H4"].includes(tf) ? tf : "";
}

function formatPrice(value, pair) {
  const n = Number(value);

  if (!Number.isFinite(n)) return "0";

  const p = normalizePair(pair);

  if (p === "XAUUSD" || p === "BTCUSD") return n.toFixed(2);
  if (p.includes("JPY")) return n.toFixed(3);

  return n.toFixed(5);
}

function cleanReason(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 350);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}
