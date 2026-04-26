import {
  buildHistoricalEdgeGate,
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

const MODEL_VERSION = "setup-alerts-sniper70-v7";
const DEFAULT_TIMEFRAME = "M15";
const CANDLE_LIMIT = 260;
const MTF_TIMEFRAMES = ["H1", "H4"];

const FRESHNESS_SECONDS = {
  M5: 60 * 60,
  M15: 3 * 60 * 60,
  H1: 8 * 60 * 60,
  H4: 24 * 60 * 60
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
      return json({ ok: false, error: "Missing DB binding" }, 500);
    }

    if (!isAuthorized(context.request, env.SYNC_SECRET || "")) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    await ensureArchiveColumns(db);
    await ensureNotificationTable(db);

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    const timeframe =
      normalizeTimeframe(url.searchParams.get("timeframe") || body.timeframe) ||
      DEFAULT_TIMEFRAME;

    const dryRun = String(url.searchParams.get("dryRun") || body.dryRun || "0") === "1";
    const notify = String(url.searchParams.get("notify") || body.notify || "1") !== "0";
    const limit = normalizeLimit(url.searchParams.get("limit") || body.limit, PAIRS.length);

    const scans = [];

    for (const pair of PAIRS.slice(0, limit)) {
      const scan = await scanPair(db, pair, timeframe);
      scans.push(scan);
    }

    const candidates = scans
      .filter((scan) => scan.sniperAllowed)
      .sort((a, b) => Number(b.sniperScore || 0) - Number(a.sniperScore || 0));

    const sent = [];
    const skipped = [];

    for (const setup of candidates.slice(0, 5)) {
      const dedupeKey = buildDedupeKey(setup);
      const alreadySent = await hasNotification(db, dedupeKey);

      if (alreadySent) {
        skipped.push({
          pair: setup.pair,
          signal: setup.signal,
          reason: "duplicate",
          dedupeKey
        });
        continue;
      }

      if (!dryRun && notify) {
        const telegramResult = await sendTelegramAlert(env, setup);

        if (!telegramResult.ok) {
          skipped.push({
            pair: setup.pair,
            signal: setup.signal,
            reason: telegramResult.error || "telegram-failed",
            dedupeKey
          });
          continue;
        }

        await saveNotification(db, dedupeKey, setup, telegramResult);
      }

      sent.push({
        pair: setup.pair,
        signal: setup.signal,
        timeframe: setup.timeframe,
        sniperScore: setup.sniperScore,
        historicalEdgeScore: setup.historicalEdgeScore,
        historicalConfidence: setup.historicalConfidence,
        entryQualityScore: setup.entryQualityScore,
        setupQualityScore: setup.setupQualityScore,
        exitPressureScore: setup.exitPressureScore,
        mtfScore: setup.mtfScore,
        setupType: setup.setupType,
        dryRun,
        dedupeKey
      });
    }

    return json({
      ok: true,
      source: "setup-alerts",
      version: MODEL_VERSION,
      timeframe,
      dryRun,
      notify,
      scannedPairs: scans.length,
      candidates: candidates.length,
      sent: sent.length,
      skipped: skipped.length,
      durationMs: Date.now() - startedAt,
      topCandidates: scans
        .slice()
        .sort((a, b) => Number(b.sniperScore || 0) - Number(a.sniperScore || 0))
        .slice(0, 10)
        .map((scan) => ({
          pair: scan.pair,
          signal: scan.signal,
          sniperAllowed: scan.sniperAllowed,
          sniperScore: scan.sniperScore,
          historicalEdgeScore: scan.historicalEdgeScore,
          historicalConfidence: scan.historicalConfidence,
          ultraScore: scan.ultraScore,
          entryQualityScore: scan.entryQualityScore,
          setupQualityScore: scan.setupQualityScore,
          exitPressureScore: scan.exitPressureScore,
          mtfScore: scan.mtfScore,
          riskScore: scan.riskScore,
          setupType: scan.setupType,
          reason: scan.sniperReason
        })),
      sentSetups: sent,
      skippedSetups: skipped
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

async function scanPair(db, pair, timeframe) {
  const candles = await getCandles(db, pair, timeframe);
  const freshness = getFreshness(candles, timeframe);

  if (candles.length < 80) {
    return buildEmptyScan(pair, timeframe, "Not enough candles");
  }

  if (!freshness.fresh) {
    return buildEmptyScan(pair, timeframe, `Stale candles: ${freshness.ageMinutes} min`);
  }

  const primary = buildTechnicalScan(pair, timeframe, candles);
  const mtf = await buildMtfAlignment(db, pair, primary.signal);

  const sniper = buildSniperDecision({
    ...primary,
    mtfScore: mtf.score,
    mtfLabel: mtf.label,
    mtfTimeframes: mtf.timeframes,
    mtfOppositeCount: mtf.oppositeCount
  });

  const historical = await buildHistoricalEdgeGate(db, {
    ...primary,
    mtfScore: mtf.score,
    mtfLabel: mtf.label,
    mtfTimeframes: mtf.timeframes,
    mtfOppositeCount: mtf.oppositeCount,
    sniperAllowed: sniper.allowed,
    sniperScore: sniper.score,
    sniperReason: sniper.reason,
    session: inferSession(new Date()),
    hour: inferHour(new Date())
  }, {
    mode: "sniper"
  });

  const finalSniperScore = Math.round(
    Number(sniper.score || 0) * 0.74 +
    Number(historical.edgeScore || 50) * 0.26
  );

  return {
    ...primary,
    fresh: true,
    candleAgeMinutes: freshness.ageMinutes,
    mtfScore: mtf.score,
    mtfLabel: mtf.label,
    mtfTimeframes: mtf.timeframes,
    mtfOppositeCount: mtf.oppositeCount,

    historicalEdge: historical,
    historicalEdgeScore: historical.edgeScore,
    historicalConfidence: historical.confidence,
    historicalReason: historical.reason,

    sniperAllowed: Boolean(sniper.allowed && historical.allowed),
    sniperScore: finalSniperScore,
    sniperReason: sniper.allowed ? historical.reason : sniper.reason,
    alertTitle: sniper.title
  };
}

async function getCandles(db, pair, timeframe) {
  const res = await db
    .prepare(`
      SELECT ts, open, high, low, close
      FROM market_candles
      WHERE pair = ?
        AND timeframe = ?
      ORDER BY ts DESC
      LIMIT ?
    `)
    .bind(pair, timeframe, CANDLE_LIMIT)
    .all();

  const rows = Array.isArray(res.results) ? res.results : [];

  return rows
    .map((row) => ({
      time: Number(row.ts || 0),
      open: Number(row.open || 0),
      high: Number(row.high || 0),
      low: Number(row.low || 0),
      close: Number(row.close || 0)
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

function buildTechnicalScan(pair, timeframe, candles) {
  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);

  const current = closes.at(-1);
  const previous = closes.at(-2) || current;

  const ema20Value = ema(closes, 20);
  const ema50Value = ema(closes, 50);
  const ema100Value = ema(closes, 100);

  const rsi14 = rsi(closes, 14);
  const atr14 = atr(highs, lows, closes, 14);
  const momentum = computeMomentum(closes, 12);
  const volatility = computeVolatility(closes, 30);
  const macdLine = ema(closes, 12) - ema(closes, 26);

  const direction = computeDirection({
    current,
    ema20Value,
    ema50Value,
    momentum,
    rsi14
  });

  const signal =
    direction === "buy"
      ? "BUY"
      : direction === "sell"
        ? "SELL"
        : "WAIT";

  const trendScore = computeTrendScore({
    current,
    ema20Value,
    ema50Value,
    ema100Value,
    momentum,
    direction
  });

  const timingScore = computeTimingScore({
    current,
    previous,
    rsi14,
    macdLine,
    momentum,
    direction
  });

  const riskScore = computeRiskScore({
    pair,
    current,
    atr14,
    volatility
  });

  const executionScore = computeExecutionScore(candles, direction, atr14);
  const smartMoneyScore = computeSmartMoneyScore(candles, direction);
  const sessionScore = computeSessionScore(pair);

  const setup = classifySetup({
    pair,
    timeframe,
    candles,
    current,
    direction,
    signal,
    atr14,
    volatility,
    momentum,
    rsi14
  });

  const localScore = clamp(
    trendScore * 0.21 +
      timingScore * 0.16 +
      riskScore * 0.12 +
      executionScore * 0.15 +
      smartMoneyScore * 0.10 +
      sessionScore * 0.07 +
      setup.setupQualityScore * 0.19,
    1,
    99
  );

  const ultraScore = computeUltraScore({
    pair,
    timeframe,
    signal,
    localScore,
    trendScore,
    timingScore,
    riskScore,
    executionScore,
    smartMoneyScore,
    sessionScore,
    setupQualityScore: setup.setupQualityScore,
    setupType: setup.setupType,
    volatility,
    volatilityRegime: setup.volatilityRegime,
    lateImpulse: setup.lateImpulse
  });

  const entryQuality = computeEntryQualityScore({
    pair,
    timeframe,
    candles,
    current,
    direction,
    signal,
    ultraScore,
    trendScore,
    timingScore,
    riskScore,
    executionScore,
    smartMoneyScore,
    sessionScore,
    setupQualityScore: setup.setupQualityScore,
    setupType: setup.setupType,
    distanceEma20Atr: setup.distanceEma20Atr,
    wickRiskScore: setup.wickRiskScore,
    lateImpulse: setup.lateImpulse,
    rsi14,
    atr14,
    momentum,
    volatility
  });

  const exitPressure = computeExitPressureScore({
    pair,
    signal,
    ultraScore,
    trendScore,
    timingScore,
    riskScore,
    executionScore,
    smartMoneyScore,
    sessionScore,
    setupType: setup.setupType,
    volatilityRegime: setup.volatilityRegime,
    wickRiskScore: setup.wickRiskScore,
    lateImpulse: setup.lateImpulse,
    rsi14,
    momentum,
    volatility
  });

  const rr = getDefaultRr(pair);
  const riskDistance = computeRiskDistance(pair, current, atr14);

  const stopLoss =
    direction === "sell"
      ? current + riskDistance
      : current - riskDistance;

  const takeProfit =
    direction === "sell"
      ? current - riskDistance * rr
      : current + riskDistance * rr;

  const tp1 =
    direction === "sell"
      ? current - riskDistance * 1.05
      : current + riskDistance * 1.05;

  const paperScore = computePaperScore({
    ultraScore,
    entryQualityScore: entryQuality.score,
    setupQualityScore: setup.setupQualityScore,
    exitPressureScore: exitPressure.score,
    riskScore,
    executionScore,
    smartMoneyScore,
    sessionScore
  });

  return {
    pair,
    timeframe,
    candleTime: candles.at(-1)?.time || 0,
    current: roundByPair(current, pair),
    previous: roundByPair(previous, pair),

    direction,
    signal,

    ultraScore: Math.round(ultraScore),
    localScore: Math.round(localScore),
    trendScore: Math.round(trendScore),
    timingScore: Math.round(timingScore),
    riskScore: Math.round(riskScore),
    executionScore: Math.round(executionScore),
    smartMoneyScore: Math.round(smartMoneyScore),
    sessionScore: Math.round(sessionScore),

    setupType: setup.setupType,
    setupLabel: setup.setupLabel,
    setupQualityScore: setup.setupQualityScore,
    setupStrength: setup.setupStrength,
    volatilityRegime: setup.volatilityRegime,
    trendRegime: setup.trendRegime,
    triggerType: setup.triggerType,
    entryModel: setup.entryModel,
    distanceEma20Atr: setup.distanceEma20Atr,
    wickRiskScore: setup.wickRiskScore,
    lateImpulse: setup.lateImpulse,

    entryQualityScore: entryQuality.score,
    entryQualityLabel: entryQuality.label,
    entryQualityReasons: entryQuality.reasons,

    exitPressureScore: exitPressure.score,
    exitPressureLabel: exitPressure.label,

    rsi14: round(rsi14, 2),
    atr14: roundByPair(atr14, pair),
    momentum: round(momentum, 3),
    volatility: round(volatility, 6),
    macdLine: round(macdLine, 6),

    paperScore: Math.round(paperScore),

    rr,
    stopLoss: roundByPair(stopLoss, pair),
    takeProfit: roundByPair(takeProfit, pair),
    tp1: roundByPair(tp1, pair)
  };
}

async function buildMtfAlignment(db, pair, primarySignal) {
  if (primarySignal !== "BUY" && primarySignal !== "SELL") {
    return {
      score: 0,
      label: "No primary direction",
      oppositeCount: 0,
      timeframes: []
    };
  }

  const rows = [];

  for (const timeframe of MTF_TIMEFRAMES) {
    const candles = await getCandles(db, pair, timeframe);

    if (candles.length < 80) {
      rows.push({
        timeframe,
        signal: "WAIT",
        ultraScore: 0,
        setupQualityScore: 0,
        aligned: false,
        opposite: false,
        reason: "not-enough-candles"
      });
      continue;
    }

    const scan = buildTechnicalScan(pair, timeframe, candles);

    const aligned = scan.signal === primarySignal;
    const opposite =
      (primarySignal === "BUY" && scan.signal === "SELL") ||
      (primarySignal === "SELL" && scan.signal === "BUY");

    rows.push({
      timeframe,
      signal: scan.signal,
      ultraScore: scan.ultraScore,
      entryQualityScore: scan.entryQualityScore,
      setupQualityScore: scan.setupQualityScore,
      setupType: scan.setupType,
      aligned,
      opposite,
      reason: aligned ? "aligned" : opposite ? "opposite" : "neutral"
    });
  }

  const alignedCount = rows.filter((row) => row.aligned).length;
  const oppositeCount = rows.filter((row) => row.opposite).length;
  const avgUltra = rows.length
    ? rows.reduce((sum, row) => sum + Number(row.ultraScore || 0), 0) / rows.length
    : 0;

  let score = 50;
  score += alignedCount * 18;
  score -= oppositeCount * 28;
  score += (avgUltra - 55) * 0.22;

  if (alignedCount >= 2) score += 8;
  if (oppositeCount > 0) score -= 12;

  const finalScore = clamp(score, 1, 99);

  return {
    score: Math.round(finalScore),
    label:
      finalScore >= 84 ? "Strong MTF alignment" :
      finalScore >= 76 ? "Valid MTF alignment" :
      finalScore >= 65 ? "Medium MTF alignment" :
      "Weak MTF alignment",
    oppositeCount,
    timeframes: rows
  };
}

function buildSniperDecision(scan) {
  const profile = getSniperProfile(scan.pair);
  const blockers = [];

  if (scan.signal !== "BUY" && scan.signal !== "SELL") {
    blockers.push("No BUY/SELL signal");
  }

  if (scan.ultraScore < profile.minUltra) {
    blockers.push(`Ultra too weak ${scan.ultraScore}/${profile.minUltra}`);
  }

  if (scan.entryQualityScore < profile.minEntry) {
    blockers.push(`Entry too weak ${scan.entryQualityScore}/${profile.minEntry}`);
  }

  if (scan.setupQualityScore < profile.minSetup) {
    blockers.push(`Setup too weak ${scan.setupQualityScore}/${profile.minSetup}`);
  }

  if (scan.exitPressureScore > profile.maxExitPressure) {
    blockers.push(`Exit pressure too high ${scan.exitPressureScore}/${profile.maxExitPressure}`);
  }

  if (scan.mtfScore < profile.minMtf) {
    blockers.push(`MTF too weak ${scan.mtfScore}/${profile.minMtf}`);
  }

  if (scan.riskScore < profile.minRisk) {
    blockers.push(`Risk too weak ${scan.riskScore}/${profile.minRisk}`);
  }

  if (scan.paperScore < profile.minPaper) {
    blockers.push(`Paper score too weak ${scan.paperScore}/${profile.minPaper}`);
  }

  if (scan.lateImpulse) {
    blockers.push("Late impulse");
  }

  if (scan.mtfOppositeCount > 0) {
    blockers.push("Higher timeframe opposite");
  }

  if (scan.volatilityRegime === "extreme") {
    blockers.push("Extreme volatility");
  }

  if (scan.setupType === "weak-signal" || scan.setupType === "late-impulse") {
    blockers.push(`Bad setup type: ${scan.setupType}`);
  }

  const sniperScore = clamp(
    scan.ultraScore * 0.23 +
      scan.entryQualityScore * 0.21 +
      scan.setupQualityScore * 0.18 +
      scan.mtfScore * 0.16 +
      scan.riskScore * 0.08 +
      scan.paperScore * 0.10 +
      (100 - scan.exitPressureScore) * 0.04,
    1,
    99
  );

  return {
    allowed: blockers.length === 0,
    score: Math.round(sniperScore),
    title: blockers.length
      ? `${scan.pair} blocked`
      : `${scan.pair} ${scan.signal} sniper setup`,
    reason: blockers.length
      ? blockers.join(" · ")
      : "SNIPER 70 setup validated: score, setup type, entry, MTF, risk and historical edge accepted."
  };
}

function getSniperProfile(pair) {
  if (pair === "BTCUSD") {
    return {
      minUltra: 85,
      minEntry: 82,
      minSetup: 80,
      maxExitPressure: 42,
      minMtf: 78,
      minRisk: 55,
      minPaper: 82
    };
  }

  if (pair === "XAUUSD") {
    return {
      minUltra: 84,
      minEntry: 80,
      minSetup: 78,
      maxExitPressure: 44,
      minMtf: 77,
      minRisk: 52,
      minPaper: 80
    };
  }

  return {
    minUltra: 82,
    minEntry: 78,
    minSetup: 76,
    maxExitPressure: 45,
    minMtf: 76,
    minRisk: 52,
    minPaper: 78
  };
}

async function sendTelegramAlert(env, setup) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return {
      ok: false,
      error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID"
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: buildTelegramMessage(setup),
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    return {
      ok: false,
      error: data?.description || `Telegram HTTP ${response.status}`
    };
  }

  return {
    ok: true,
    telegramMessageId: data.result?.message_id || null
  };
}

function buildTelegramMessage(setup) {
  const directionIcon = setup.signal === "BUY" ? "🟢" : "🔴";
  const side = setup.signal === "BUY" ? "BUY / hausse" : "SELL / baisse";

  return [
    `${directionIcon} <b>SNIPER 70 SETUP</b>`,
    ``,
    `<b>${setup.pair}</b> · ${setup.timeframe} · <b>${side}</b>`,
    `Type: <b>${escapeTelegram(setup.setupLabel || setup.setupType || "-")}</b>`,
    ``,
    `Prix: <b>${formatPrice(setup.current, setup.pair)}</b>`,
    `Stop: ${formatPrice(setup.stopLoss, setup.pair)}`,
    `TP1: ${formatPrice(setup.tp1, setup.pair)}`,
    `TP2: ${formatPrice(setup.takeProfit, setup.pair)}`,
    ``,
    `Sniper: <b>${setup.sniperScore}/100</b>`,
    `Historical edge: ${setup.historicalEdgeScore}/100 · confidence ${setup.historicalConfidence}%`,
    `Ultra: ${setup.ultraScore}/100`,
    `Setup quality: ${setup.setupQualityScore}/100`,
    `Entry: ${setup.entryQualityScore}/100`,
    `Exit pressure: ${setup.exitPressureScore}/100`,
    `MTF: ${setup.mtfScore}/100`,
    `Risk: ${setup.riskScore}/100`,
    ``,
    `MTF: ${setup.mtfTimeframes.map((tf) => `${tf.timeframe}:${tf.signal}:${tf.ultraScore}`).join(" · ")}`,
    ``,
    `Raison: ${escapeTelegram(setup.sniperReason)}`,
    ``,
    `⚠️ Alerte paper/sniper. Ce n’est pas une garantie de gain.`
  ].join("\n");
}

async function ensureNotificationTable(db) {
  await db
    .prepare(`
      CREATE TABLE IF NOT EXISTS setup_notifications (
        dedupe_key TEXT PRIMARY KEY,
        sent_at TEXT NOT NULL,
        pair TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        signal TEXT NOT NULL,
        candle_time INTEGER NOT NULL,
        sniper_score REAL,
        entry_quality_score REAL,
        exit_pressure_score REAL,
        mtf_score REAL,
        telegram_message_id TEXT,
        source TEXT
      )
    `)
    .run();
}

async function hasNotification(db, dedupeKey) {
  const row = await db
    .prepare(`
      SELECT dedupe_key
      FROM setup_notifications
      WHERE dedupe_key = ?
      LIMIT 1
    `)
    .bind(dedupeKey)
    .first();

  return Boolean(row?.dedupe_key);
}

async function saveNotification(db, dedupeKey, setup, telegramResult) {
  await db
    .prepare(`
      INSERT OR REPLACE INTO setup_notifications (
        dedupe_key,
        sent_at,
        pair,
        timeframe,
        signal,
        candle_time,
        sniper_score,
        entry_quality_score,
        exit_pressure_score,
        mtf_score,
        telegram_message_id,
        source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      dedupeKey,
      new Date().toISOString(),
      setup.pair,
      setup.timeframe,
      setup.signal,
      Number(setup.candleTime || 0),
      Number(setup.sniperScore || 0),
      Number(setup.entryQualityScore || 0),
      Number(setup.exitPressureScore || 0),
      Number(setup.mtfScore || 0),
      String(telegramResult.telegramMessageId || ""),
      MODEL_VERSION
    )
    .run();
}

function buildDedupeKey(setup) {
  return [
    MODEL_VERSION,
    setup.pair,
    setup.timeframe,
    setup.signal,
    setup.candleTime
  ].join("|");
}

function buildEmptyScan(pair, timeframe, reason) {
  return {
    pair,
    timeframe,
    signal: "WAIT",
    sniperAllowed: false,
    sniperScore: 0,
    historicalEdgeScore: 0,
    historicalConfidence: 0,
    ultraScore: 0,
    entryQualityScore: 0,
    setupQualityScore: 0,
    exitPressureScore: 99,
    mtfScore: 0,
    riskScore: 0,
    paperScore: 0,
    setupType: "weak-signal",
    setupLabel: "Weak signal",
    sniperReason: reason
  };
}

function classifySetup(input) {
  const pair = String(input.pair || "").toUpperCase();
  const candles = input.candles || [];
  const direction = String(input.direction || "wait").toLowerCase();

  if (candles.length < 40 || (direction !== "buy" && direction !== "sell")) {
    return {
      setupType: "weak-signal",
      setupLabel: "Weak signal",
      setupQualityScore: 0,
      setupStrength: "blocked",
      volatilityRegime: "unknown",
      trendRegime: "unknown",
      triggerType: "none",
      entryModel: "none",
      distanceEma20Atr: 0,
      wickRiskScore: 50,
      lateImpulse: false
    };
  }

  const closes = candles.map((c) => Number(c.close || 0));
  const highs = candles.map((c) => Number(c.high || 0));
  const lows = candles.map((c) => Number(c.low || 0));
  const current = Number(input.current || closes.at(-1) || 0);
  const last = candles.at(-1);

  const ema20Value = ema(closes, 20);
  const ema50Value = ema(closes, 50);
  const atrValue = Number(input.atr14 || atr(highs, lows, closes, 14));
  const volatility = Number(input.volatility || computeVolatility(closes, 30));

  const range = Math.max(0.0000001, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;

  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWickRatio = upperWick / range;
  const lowerWickRatio = lowerWick / range;

  const distanceEma20Atr = atrValue > 0 ? Math.abs(current - ema20Value) / atrValue : 0;
  const atrPercent = current > 0 ? atrValue / current : 0;
  const recent = candles.slice(-12);
  const prevHigh = Math.max(...recent.slice(0, -1).map((c) => c.high));
  const prevLow = Math.min(...recent.slice(0, -1).map((c) => c.low));

  const trendUp = ema20Value > ema50Value && current > ema20Value;
  const trendDown = ema20Value < ema50Value && current < ema20Value;

  const trendRegime =
    trendUp ? "uptrend" :
    trendDown ? "downtrend" :
    Math.abs(ema20Value - ema50Value) / Math.max(current, 0.0000001) < 0.0015 ? "range" :
    "mixed";

  const volatilityRegime = getVolatilityRegime(pair, volatility, atrPercent);

  const buyBreakout = direction === "buy" && last.close > prevHigh && last.close > last.open;
  const sellBreakout = direction === "sell" && last.close < prevLow && last.close < last.open;

  const buyPullback =
    direction === "buy" &&
    trendUp &&
    last.low <= ema20Value + atrValue * 0.35 &&
    last.close > ema20Value &&
    last.close > last.open;

  const sellPullback =
    direction === "sell" &&
    trendDown &&
    last.high >= ema20Value - atrValue * 0.35 &&
    last.close < ema20Value &&
    last.close < last.open;

  const buyRejection =
    direction === "buy" &&
    lowerWickRatio >= 0.34 &&
    last.close > last.open &&
    last.close > last.low + range * 0.62;

  const sellRejection =
    direction === "sell" &&
    upperWickRatio >= 0.34 &&
    last.close < last.open &&
    last.close < last.high - range * 0.62;

  const impulseTooLarge = atrValue > 0 && range > atrValue * 2.35;
  const lateImpulse = isLateImpulse(pair, distanceEma20Atr, impulseTooLarge);
  const wickRiskScore = computeWickRiskScore(direction, upperWickRatio, lowerWickRatio, bodyRatio);

  let setupType = "weak-signal";
  let triggerType = "none";
  let entryModel = "none";
  let score = 48;

  if (buyPullback || sellPullback) {
    setupType = "trend-pullback";
    triggerType = "ema-reclaim";
    entryModel = "pullback-confirmation";
    score += 26;
  } else if (buyBreakout || sellBreakout) {
    setupType = "breakout-continuation";
    triggerType = "range-break";
    entryModel = "breakout-confirmation";
    score += 22;
  } else if (buyRejection || sellRejection) {
    setupType = "liquidity-rejection";
    triggerType = "wick-rejection";
    entryModel = "rejection-confirmation";
    score += 20;
  } else if (
    (direction === "buy" && trendUp && bodyRatio >= 0.45) ||
    (direction === "sell" && trendDown && bodyRatio >= 0.45)
  ) {
    setupType = "momentum-continuation";
    triggerType = "momentum-candle";
    entryModel = "momentum-confirmation";
    score += 16;
  } else if (trendRegime === "range") {
    setupType = "range-signal";
    triggerType = "range";
    entryModel = "range-risk";
    score -= 8;
  }

  if (trendRegime === "uptrend" && direction === "buy") score += 7;
  if (trendRegime === "downtrend" && direction === "sell") score += 7;
  if (trendRegime === "mixed") score -= 5;
  if (trendRegime === "range") score -= 8;

  if (bodyRatio >= 0.48 && bodyRatio <= 0.82) score += 7;
  if (wickRiskScore >= 65) score -= 10;

  if (lateImpulse) {
    setupType = "late-impulse";
    triggerType = "late";
    entryModel = "avoid-late-entry";
    score -= 24;
  } else if (distanceEma20Atr <= 1.2) {
    score += 7;
  } else if (distanceEma20Atr <= 2.0) {
    score += 2;
  } else {
    score -= 8;
  }

  if (volatilityRegime === "normal") score += 5;
  if (volatilityRegime === "quiet") score -= 3;
  if (volatilityRegime === "elevated") score -= pair === "BTCUSD" || pair === "XAUUSD" ? 7 : 5;
  if (volatilityRegime === "extreme") score -= 18;

  if (pair === "BTCUSD") score -= 3;
  if (pair === "XAUUSD") score -= 1;

  const setupQualityScore = Math.round(clamp(score, 1, 99));

  return {
    setupType,
    setupLabel: labelSetup(setupType),
    setupQualityScore,
    setupStrength:
      setupQualityScore >= 84 ? "sniper" :
      setupQualityScore >= 76 ? "strong" :
      setupQualityScore >= 66 ? "medium" :
      "weak",
    volatilityRegime,
    trendRegime,
    triggerType,
    entryModel,
    distanceEma20Atr: Number(distanceEma20Atr.toFixed(2)),
    wickRiskScore: Math.round(wickRiskScore),
    lateImpulse
  };
}

function computeWickRiskScore(direction, upperWickRatio, lowerWickRatio, bodyRatio) {
  let score = 30;

  if (direction === "buy") {
    score += upperWickRatio * 90;
    if (lowerWickRatio > 0.32) score -= 10;
  }

  if (direction === "sell") {
    score += lowerWickRatio * 90;
    if (upperWickRatio > 0.32) score -= 10;
  }

  if (bodyRatio < 0.25) score += 10;

  return clamp(score, 1, 99);
}

function isLateImpulse(pair, distanceEma20Atr, impulseTooLarge) {
  const maxDistance =
    pair === "BTCUSD" ? 3.1 :
    pair === "XAUUSD" ? 2.75 :
    2.45;

  return distanceEma20Atr > maxDistance || impulseTooLarge;
}

function getVolatilityRegime(pair, volatility, atrPercent) {
  const p = String(pair || "").toUpperCase();

  if (p === "BTCUSD") {
    if (volatility > 0.04 || atrPercent > 0.045) return "extreme";
    if (volatility > 0.025 || atrPercent > 0.028) return "elevated";
    if (volatility < 0.003 || atrPercent < 0.002) return "quiet";
    return "normal";
  }

  if (p === "XAUUSD") {
    if (volatility > 0.025 || atrPercent > 0.03) return "extreme";
    if (volatility > 0.016 || atrPercent > 0.018) return "elevated";
    if (volatility < 0.001 || atrPercent < 0.0008) return "quiet";
    return "normal";
  }

  if (volatility > 0.018 || atrPercent > 0.018) return "extreme";
  if (volatility > 0.011 || atrPercent > 0.011) return "elevated";
  if (volatility < 0.00035 || atrPercent < 0.00025) return "quiet";

  return "normal";
}

function labelSetup(type) {
  const labels = {
    "trend-pullback": "Trend pullback",
    "breakout-continuation": "Breakout continuation",
    "liquidity-rejection": "Liquidity rejection",
    "momentum-continuation": "Momentum continuation",
    "range-signal": "Range signal",
    "late-impulse": "Late impulse",
    "weak-signal": "Weak signal"
  };

  return labels[type] || "Unknown setup";
}

function computeDirection(data) {
  const bullish =
    data.ema20Value > data.ema50Value &&
    data.current > data.ema20Value &&
    data.momentum > 0 &&
    data.rsi14 >= 45;

  const bearish =
    data.ema20Value < data.ema50Value &&
    data.current < data.ema20Value &&
    data.momentum < 0 &&
    data.rsi14 <= 55;

  if (bullish) return "buy";
  if (bearish) return "sell";

  return "wait";
}

function computeTrendScore(data) {
  let score = 50;

  score += data.ema20Value > data.ema50Value ? 14 : -14;
  score += data.ema50Value > data.ema100Value ? 8 : -8;
  score += data.current > data.ema20Value ? 8 : -8;
  score += data.momentum > 0 ? 10 : -10;

  if (data.direction === "buy" && data.current > data.ema20Value && data.ema20Value > data.ema50Value) score += 8;
  if (data.direction === "sell" && data.current < data.ema20Value && data.ema20Value < data.ema50Value) score += 8;
  if (data.direction === "wait") score -= 8;

  return clamp(score, 1, 99);
}

function computeTimingScore(data) {
  let score = 50;

  score += data.rsi14 >= 43 && data.rsi14 <= 66 ? 14 : -8;
  score += data.macdLine > 0 ? 8 : -8;
  score += data.momentum > 0 ? 8 : -8;
  score += data.current > data.previous ? 5 : -5;

  if (data.direction === "sell") {
    score += data.macdLine < 0 ? 8 : -8;
    score += data.momentum < 0 ? 8 : -8;
    score += data.current < data.previous ? 5 : -5;
  }

  if (data.direction === "wait") score -= 6;

  return clamp(score, 1, 99);
}

function computeRiskScore(data) {
  const pair = String(data.pair || "").toUpperCase();
  const volatility = Number(data.volatility || 0);

  let score = 76;

  score -= Math.min(22, volatility * 900);

  if (pair === "BTCUSD") score -= 10;
  if (pair === "XAUUSD") score -= 8;
  if (pair.startsWith("GBP")) score -= 2;

  if (data.atr14 && data.current) {
    const atrPercent = data.atr14 / data.current;

    if (pair === "BTCUSD") {
      if (atrPercent >= 0.002 && atrPercent <= 0.025) score += 6;
      if (atrPercent > 0.045) score -= 12;
    } else if (pair === "XAUUSD") {
      if (atrPercent >= 0.0008 && atrPercent <= 0.015) score += 5;
      if (atrPercent > 0.03) score -= 10;
    } else {
      if (atrPercent >= 0.00025 && atrPercent <= 0.008) score += 5;
      if (atrPercent > 0.018) score -= 10;
    }
  }

  return clamp(score, 1, 99);
}

function computeExecutionScore(candles, direction, atr14) {
  if (candles.length < 30 || direction === "wait") return 50;

  const last = candles.at(-1);
  const prev = candles.at(-2);
  const range = Math.max(0.0000001, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;

  let score = 52;

  if (bodyRatio >= 0.45 && bodyRatio <= 0.82) score += 10;
  if (atr14 > 0 && range <= atr14 * 1.8) score += 8;

  if (direction === "buy") {
    if (last.close > last.open) score += 7;
    if (last.close > prev.high) score += 8;
    if (last.close > last.low + range * 0.68) score += 5;
  }

  if (direction === "sell") {
    if (last.close < last.open) score += 7;
    if (last.close < prev.low) score += 8;
    if (last.close < last.high - range * 0.68) score += 5;
  }

  if (atr14 > 0 && range > atr14 * 2.5) score -= 12;

  return clamp(score, 1, 99);
}

function computeSmartMoneyScore(candles, direction) {
  if (candles.length < 24 || direction === "wait") return 50;

  const recent = candles.slice(-12);
  const previous = candles.slice(-24, -12);
  const last = candles.at(-1);

  const recentRange = average(recent.map((c) => c.high - c.low));
  const previousRange = average(previous.map((c) => c.high - c.low));
  const body = Math.abs(last.close - last.open);
  const range = Math.max(0.0000001, last.high - last.low);
  const bodyRatio = body / range;

  let score = 50;

  if (recentRange > previousRange) score += 8;
  if (bodyRatio >= 0.55) score += 10;
  if (direction === "buy" && last.close > last.open) score += 8;
  if (direction === "sell" && last.close < last.open) score += 8;

  return clamp(score, 1, 99);
}

function computeSessionScore(pair = "") {
  const hour = inferHour(new Date());
  const p = String(pair || "").toUpperCase();

  if (p === "BTCUSD") {
    if (hour >= 13 && hour < 23) return 66;
    if (hour >= 1 && hour < 8) return 58;
    return 54;
  }

  if (hour >= 14 && hour < 18) return 68;
  if (hour >= 9 && hour < 14) return 62;
  if (hour >= 18 && hour < 21) return 56;
  if (hour >= 1 && hour < 8) return 52;

  return 44;
}

function computeUltraScore(data) {
  let score = clamp(
    Number(data.localScore || 50) * 0.23 +
      Number(data.trendScore || 50) * 0.13 +
      Number(data.timingScore || 50) * 0.11 +
      Number(data.executionScore || 50) * 0.13 +
      Number(data.smartMoneyScore || 50) * 0.09 +
      Number(data.riskScore || 50) * 0.08 +
      Number(data.sessionScore || 50) * 0.08 +
      Number(data.setupQualityScore || 50) * 0.15,
    1,
    99
  );

  if (data.signal === "WAIT") score -= 16;
  if (data.lateImpulse) score -= 14;
  if (data.setupType === "trend-pullback") score += 5;
  if (data.setupType === "breakout-continuation") score += 3;
  if (data.setupType === "liquidity-rejection") score += 3;
  if (data.setupType === "range-signal") score -= 8;
  if (data.setupType === "weak-signal") score -= 10;
  if (data.setupType === "late-impulse") score -= 18;
  if (data.volatilityRegime === "normal") score += 3;
  if (data.volatilityRegime === "elevated") score -= 6;
  if (data.volatilityRegime === "extreme") score -= 15;

  if (data.pair === "BTCUSD") score -= 3;
  if (data.pair === "XAUUSD" && data.volatility > 0.025) score -= 8;

  return clamp(score, 1, 99);
}

function computeEntryQualityScore(data) {
  if (data.direction !== "buy" && data.direction !== "sell") {
    return { score: 0, label: "no-direction", reasons: ["No direction"] };
  }

  let score = 50;
  const reasons = [];

  score += (Number(data.ultraScore || 0) - 70) * 0.18;
  score += (Number(data.setupQualityScore || 50) - 50) * 0.22;
  score += (Number(data.trendScore || 50) - 50) * 0.12;
  score += (Number(data.timingScore || 50) - 50) * 0.14;
  score += (Number(data.executionScore || 50) - 50) * 0.15;
  score += (Number(data.smartMoneyScore || 50) - 50) * 0.09;
  score += (Number(data.riskScore || 50) - 50) * 0.04;

  if (data.setupType === "trend-pullback") {
    score += 8;
    reasons.push("Best setup type: trend pullback");
  }

  if (data.setupType === "breakout-continuation") {
    score += 5;
    reasons.push("Valid breakout continuation");
  }

  if (data.setupType === "liquidity-rejection") {
    score += 5;
    reasons.push("Valid liquidity rejection");
  }

  if (data.setupType === "late-impulse") {
    score -= 22;
    reasons.push("Late impulse blocked");
  }

  if (data.signal === "BUY" || data.signal === "SELL") {
    score += 4;
    reasons.push("Directional signal active");
  }

  if (data.rsi14 > 74 && data.direction === "buy") {
    score -= data.pair === "BTCUSD" ? 10 : 7;
    reasons.push("RSI buy extended");
  }

  if (data.rsi14 < 26 && data.direction === "sell") {
    score -= data.pair === "BTCUSD" ? 10 : 7;
    reasons.push("RSI sell extended");
  }

  if (data.wickRiskScore >= 65) {
    score -= 8;
    reasons.push("Opposite wick risk");
  }

  if (data.distanceEma20Atr > 2.2) {
    score -= 7;
    reasons.push("Far from EMA20");
  }

  if (data.pair === "BTCUSD") {
    score -= 3;
    reasons.push("BTC risk discount");
  }

  const finalScore = clamp(score, 1, 99);

  return {
    score: Math.round(finalScore),
    label:
      finalScore >= 84 ? "sniper-entry" :
      finalScore >= 74 ? "clean-entry" :
      finalScore >= 66 ? "acceptable-entry" :
      "weak-entry",
    reasons
  };
}

function computeExitPressureScore(data) {
  let score = 28;

  score += weakness(data.trendScore, 50) * 0.18;
  score += weakness(data.timingScore, 48) * 0.16;
  score += weakness(data.executionScore, 48) * 0.16;
  score += weakness(data.smartMoneyScore, 48) * 0.10;
  score += weakness(data.riskScore, 44) * 0.10;

  if (data.signal === "WAIT") score += 10;
  if (data.lateImpulse) score += 14;
  if (data.setupType === "late-impulse") score += 12;
  if (data.setupType === "range-signal") score += 8;
  if (data.volatilityRegime === "elevated") score += 6;
  if (data.volatilityRegime === "extreme") score += 16;
  if (data.wickRiskScore >= 65) score += 8;

  if (data.pair === "BTCUSD") {
    if (data.volatility > 0.035) score += 12;
    if (Math.abs(data.momentum) > 7) score += 8;
  }

  if (data.pair === "XAUUSD") {
    if (data.volatility > 0.025) score += 10;
    if (Math.abs(data.momentum) > 3.2) score += 6;
  }

  if (data.ultraScore >= 82 && data.executionScore >= 62 && data.setupQualityScore >= 76) {
    score -= 8;
  }

  const finalScore = clamp(score, 1, 99);

  return {
    score: Math.round(finalScore),
    label:
      finalScore >= 84 ? "close-pressure" :
      finalScore >= 68 ? "reduce-pressure" :
      finalScore >= 54 ? "trail-pressure" :
      "hold"
  };
}

function computePaperScore(data) {
  return clamp(
    Number(data.ultraScore || 0) * 0.25 +
      Number(data.entryQualityScore || 0) * 0.22 +
      Number(data.setupQualityScore || 50) * 0.18 +
      Number(data.executionScore || 50) * 0.09 +
      Number(data.smartMoneyScore || 50) * 0.06 +
      Number(data.riskScore || 50) * 0.05 +
      Number(data.sessionScore || 50) * 0.05 +
      (100 - Number(data.exitPressureScore || 50)) * 0.10,
    1,
    99
  );
}

function computeRiskDistance(pair, current, atr14) {
  const atrMultiplier =
    pair === "BTCUSD" ? 1.85 :
    pair === "XAUUSD" ? 1.55 :
    pair.includes("JPY") ? 1.55 :
    1.4;

  const fallback =
    pair === "BTCUSD" ? current * 0.006 :
    pair === "XAUUSD" ? current * 0.003 :
    current * 0.002;

  return atr14 > 0 ? atr14 * atrMultiplier : fallback;
}

function getDefaultRr(pair) {
  if (pair === "BTCUSD") return 1.45;
  if (pair === "XAUUSD") return 1.5;
  return 1.35;
}

function getFreshness(candles, timeframe) {
  const lastTs = Number(candles.at(-1)?.time || 0);
  const now = Math.floor(Date.now() / 1000);
  const maxAge = FRESHNESS_SECONDS[timeframe] || FRESHNESS_SECONDS.M15;

  if (!lastTs) {
    return { fresh: false, ageSeconds: 999999999, ageMinutes: 999999 };
  }

  const ageSeconds = Math.max(0, now - lastTs);

  return {
    fresh: ageSeconds <= maxAge,
    ageSeconds,
    ageMinutes: Math.round(ageSeconds / 60)
  };
}

function ema(values, period) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;

  const k = 2 / (period + 1);
  let prev = nums[0];

  for (let i = 1; i < nums.length; i += 1) {
    prev = nums[i] * k + prev * (1 - k);
  }

  return prev;
}

function rsi(values, period = 14) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = nums.length - period; i < nums.length; i += 1) {
    const diff = nums[i] - nums[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0 && gains === 0) return 50;
  if (losses === 0) return 100;

  return 100 - 100 / (1 + gains / losses);
}

function atr(highs, lows, closes, period = 14) {
  if (highs.length < 2) return 0;

  const trs = [];

  for (let i = 1; i < highs.length; i += 1) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }

  const recent = trs.slice(-period);
  if (!recent.length) return 0;

  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function computeMomentum(values, lookback = 12) {
  if (values.length <= lookback) return 0;

  const current = values.at(-1);
  const past = values.at(-1 - lookback);

  if (!past) return 0;

  return ((current - past) / past) * 100;
}

function computeVolatility(values, period = 30) {
  const closes = values.slice(-period).map(Number).filter(Number.isFinite);
  if (closes.length < 3) return 0;

  const returns = [];

  for (let i = 1; i < closes.length; i += 1) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  const avg = average(returns);
  const variance = average(returns.map((value) => Math.pow(value - avg, 2)));

  return Math.sqrt(variance);
}

function weakness(score, level) {
  const n = Number(score || 50);

  if (n >= level + 18) return 0;
  if (n >= level + 10) return 10;
  if (n >= level) return 25;
  if (n >= level - 10) return 45;

  return 65;
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;

  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function inferSession(date = new Date()) {
  const hour = inferHour(date);
  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const tokyo = hour >= 1 && hour < 10;

  if (london && newYork) return "London+NewYork";
  if (london) return "London";
  if (newYork) return "NewYork";
  if (tokyo) return "Tokyo";

  return "OffSession";
}

function inferHour(date = new Date()) {
  return Number(
    new Date(date).toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );
}

function normalizeTimeframe(value) {
  const timeframe = String(value || "").toUpperCase().trim();
  return ["M5", "M15", "H1", "H4"].includes(timeframe) ? timeframe : "";
}

function normalizeLimit(value, fallback) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return 1;
  if (n > PAIRS.length) return PAIRS.length;
  return Math.round(n);
}

function roundByPair(value, pair) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  if (pair === "XAUUSD" || pair === "BTCUSD") return Number(n.toFixed(2));
  if (pair.includes("JPY")) return Number(n.toFixed(3));

  return Number(n.toFixed(5));
}

function formatPrice(value, pair) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";

  if (pair === "XAUUSD" || pair === "BTCUSD") return n.toFixed(2);
  if (pair.includes("JPY")) return n.toFixed(3);

  return n.toFixed(5);
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function clamp(value, min = 1, max = 99) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function escapeTelegram(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    if (!contentType.toLowerCase().includes("application/json")) return {};
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
