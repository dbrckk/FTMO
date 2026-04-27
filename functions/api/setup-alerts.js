const MODEL_VERSION = "setup-alerts-v4-ftmo-server";

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

    await ensureSetupAlertTables(db);

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    const timeframe =
      normalizeTimeframe(url.searchParams.get("timeframe") || body.timeframe) ||
      "M15";

    const dryRun = readBool(url, body, "dryRun", false);
    const force = readBool(url, body, "force", false);

    const minPaperScore = readNumber(url, body, "minPaperScore", 76);
    const minUltraScore = readNumber(url, body, "minUltraScore", 72);
    const minEntryQuality = readNumber(url, body, "minEntryQuality", 68);
    const maxExitPressure = readNumber(url, body, "maxExitPressure", 67);
    const maxAlerts = readNumber(url, body, "maxAlerts", 3);
    const cooldownMinutes = readNumber(url, body, "cooldownMinutes", 90);

    const telegramToken =
      env.TELEGRAM_BOT_TOKEN ||
      env.TG_BOT_TOKEN ||
      env.BOT_TOKEN ||
      "";

    const telegramChatId =
      env.TELEGRAM_CHAT_ID ||
      env.TG_CHAT_ID ||
      env.CHAT_ID ||
      "";

    const paperRun = await runPaperScan(context.request, env, timeframe);

    if (!paperRun.ok) {
      return json({
        ok: false,
        source: "setup-alerts",
        version: MODEL_VERSION,
        error: "paper-run failed",
        paperRun
      }, 500);
    }

    const candidates = Array.isArray(paperRun.topCandidates)
      ? paperRun.topCandidates
      : [];

    const validCandidates = candidates
      .filter((item) => item)
      .filter((item) => item.signal === "BUY" || item.signal === "SELL")
      .filter((item) => item.tradeAllowed === true)
      .filter((item) => item.ftmoAllowed !== false)
      .filter((item) => Number(item.paperScore || 0) >= minPaperScore)
      .filter((item) => Number(item.ultraScore || 0) >= minUltraScore)
      .filter((item) => Number(item.entryQualityScore || 0) >= minEntryQuality)
      .filter((item) => Number(item.exitPressureScore || 99) <= maxExitPressure)
      .sort((a, b) => Number(b.paperScore || 0) - Number(a.paperScore || 0))
      .slice(0, maxAlerts);

    const results = [];
    let sent = 0;
    let skipped = 0;

    for (const setup of validCandidates) {
      const alertKey = buildAlertKey(setup, timeframe);
      const recent = force
        ? false
        : await hasRecentAlert(db, setup, alertKey, cooldownMinutes);

      if (recent) {
        skipped += 1;
        results.push({
          pair: setup.pair,
          signal: setup.signal,
          alertKey,
          status: "skipped",
          reason: `Cooldown active: ${cooldownMinutes} min`
        });
        continue;
      }

      const message = buildTelegramMessage(setup, {
        timeframe,
        minPaperScore,
        minUltraScore,
        minEntryQuality,
        maxExitPressure
      });

      if (!dryRun) {
        if (!telegramToken || !telegramChatId) {
          results.push({
            pair: setup.pair,
            signal: setup.signal,
            alertKey,
            status: "not-sent",
            reason: "Missing Telegram token or chat id",
            message
          });
          continue;
        }

        const tg = await sendTelegramMessage({
          token: telegramToken,
          chatId: telegramChatId,
          message
        });

        if (!tg.ok) {
          results.push({
            pair: setup.pair,
            signal: setup.signal,
            alertKey,
            status: "telegram-error",
            telegram: tg
          });
          continue;
        }

        await saveAlert(db, {
          alertKey,
          setup,
          message,
          source: MODEL_VERSION
        });

        sent += 1;

        results.push({
          pair: setup.pair,
          signal: setup.signal,
          alertKey,
          status: "sent",
          telegram: {
            ok: true
          }
        });
      } else {
        results.push({
          pair: setup.pair,
          signal: setup.signal,
          alertKey,
          status: "dry-run",
          message
        });
      }
    }

    const durationMs = Date.now() - startedAt;

    return json({
      ok: true,
      source: "setup-alerts",
      version: MODEL_VERSION,
      dryRun,
      force,
      timeframe,
      durationMs,

      filters: {
        minPaperScore,
        minUltraScore,
        minEntryQuality,
        maxExitPressure,
        maxAlerts,
        cooldownMinutes
      },

      paperRun: {
        version: paperRun.version,
        scannedPairs: paperRun.scannedPairs,
        opened: paperRun.opened,
        closed: paperRun.closed,
        openBefore: paperRun.openBefore,
        openAfter: paperRun.openAfter
      },

      candidates: candidates.length,
      validCandidates: validCandidates.length,
      sent,
      skipped,
      results
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

async function ensureSetupAlertTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS setup_alerts_sent (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      alert_key TEXT NOT NULL,
      pair TEXT,
      timeframe TEXT,
      signal TEXT,
      setup_type TEXT,
      paper_score REAL,
      ultra_score REAL,
      entry_quality_score REAL,
      exit_pressure_score REAL,
      ftmo_status TEXT,
      ftmo_risk_percent REAL,
      message TEXT,
      source TEXT
    )
  `).run();

  await addColumnIfMissing(db, "setup_alerts_sent", "ftmo_status", "TEXT");
  await addColumnIfMissing(db, "setup_alerts_sent", "ftmo_risk_percent", "REAL");
  await addColumnIfMissing(db, "setup_alerts_sent", "entry_quality_score", "REAL");
  await addColumnIfMissing(db, "setup_alerts_sent", "exit_pressure_score", "REAL");
  await addColumnIfMissing(db, "setup_alerts_sent", "message", "TEXT");
  await addColumnIfMissing(db, "setup_alerts_sent", "source", "TEXT");
}

async function addColumnIfMissing(db, table, column, type) {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch {
    // Column already exists.
  }
}

async function runPaperScan(request, env, timeframe) {
  const paperUrl = new URL("/api/paper-run", request.url);

  paperUrl.searchParams.set("timeframe", timeframe);
  paperUrl.searchParams.set("dryRun", "1");

  if (env.SYNC_SECRET) {
    paperUrl.searchParams.set("token", env.SYNC_SECRET);
  }

  const response = await fetch(paperUrl.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = {
      ok: false,
      error: "Invalid paper-run JSON response"
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      ...data
    };
  }

  return data;
}

async function hasRecentAlert(db, setup, alertKey, cooldownMinutes) {
  const since = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();

  try {
    const row = await db.prepare(`
      SELECT id
      FROM setup_alerts_sent
      WHERE created_at >= ?
        AND (
          alert_key = ?
          OR (
            pair = ?
            AND timeframe = ?
            AND signal = ?
          )
        )
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(
      since,
      alertKey,
      setup.pair,
      setup.timeframe || "M15",
      setup.signal
    ).first();

    return Boolean(row?.id);
  } catch {
    return false;
  }
}

async function saveAlert(db, data) {
  await db.prepare(`
    INSERT INTO setup_alerts_sent (
      id,
      created_at,
      alert_key,
      pair,
      timeframe,
      signal,
      setup_type,
      paper_score,
      ultra_score,
      entry_quality_score,
      exit_pressure_score,
      ftmo_status,
      ftmo_risk_percent,
      message,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    new Date().toISOString(),
    data.alertKey,
    data.setup.pair,
    data.setup.timeframe || "M15",
    data.setup.signal,
    data.setup.setupType || "",
    Number(data.setup.paperScore || 0),
    Number(data.setup.ultraScore || 0),
    Number(data.setup.entryQualityScore || 0),
    Number(data.setup.exitPressureScore || 0),
    data.setup.ftmoStatus || "",
    Number(data.setup.ftmoRecommendedRiskPercent || 0),
    data.message,
    data.source
  ).run();
}

function buildAlertKey(setup, timeframe) {
  const pair = String(setup.pair || "").toUpperCase();
  const signal = String(setup.signal || "").toUpperCase();
  const setupType = String(setup.setupType || "unknown").toLowerCase();
  const currentBucket = Math.round(Number(setup.current || 0) * getPriceBucketMultiplier(pair));

  return [
    "setup",
    timeframe,
    pair,
    signal,
    setupType,
    currentBucket
  ].join("_");
}

function getPriceBucketMultiplier(pair) {
  const p = String(pair || "").toUpperCase();

  if (p === "BTCUSD") return 0.1;
  if (p === "XAUUSD") return 1;
  if (p.includes("JPY")) return 100;

  return 10000;
}

function buildTelegramMessage(setup, options) {
  const directionIcon = setup.signal === "BUY" ? "🟢" : "🔴";
  const risk = Number(setup.ftmoRecommendedRiskPercent || 0);
  const riskAmount = Number(setup.ftmoRecommendedRiskAmount || 0);

  return [
    `${directionIcon} <b>FTMO SETUP ${escapeHtml(setup.signal)}</b>`,
    ``,
    `<b>${escapeHtml(setup.pair)}</b> · ${escapeHtml(setup.timeframe || options.timeframe)} · ${escapeHtml(setup.setupLabel || setup.setupType || "setup")}`,
    ``,
    `Entry: <b>${escapeHtml(formatValue(setup.current))}</b>`,
    `SL: <b>${escapeHtml(formatValue(setup.stopLoss))}</b>`,
    `TP: <b>${escapeHtml(formatValue(setup.takeProfit))}</b>`,
    `TP1: <b>${escapeHtml(formatValue(setup.tp1))}</b>`,
    `R/R: <b>${escapeHtml(formatValue(setup.rr))}</b>`,
    ``,
    `Paper score: <b>${Number(setup.paperScore || 0)}/100</b>`,
    `Ultra: <b>${Number(setup.ultraScore || 0)}/100</b>`,
    `Entry quality: <b>${Number(setup.entryQualityScore || 0)}/100</b>`,
    `Exit pressure: <b>${Number(setup.exitPressureScore || 0)}/100</b>`,
    ``,
    `FTMO: <b>${escapeHtml(setup.ftmoStatus || "safe")}</b>`,
    `Max risk: <b>${risk.toFixed(3)}%</b>`,
    riskAmount ? `Risk amount: <b>${riskAmount.toFixed(2)}</b>` : ``,
    ``,
    `Trend: ${escapeHtml(setup.trendRegime || "unknown")}`,
    `Volatility: ${escapeHtml(setup.volatilityRegime || "unknown")}`,
    `Historical edge: <b>${Number(setup.historicalEdgeScore || 0)}/100</b>`,
    ``,
    `<i>${escapeHtml(setup.ftmoReason || setup.tradeReason || "FTMO compatible setup.")}</i>`
  ].filter(Boolean).join("\n");
}

async function sendTelegramMessage(data) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${data.token}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: data.chatId,
        text: data.message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || result.ok === false) {
      return {
        ok: false,
        status: response.status,
        result
      };
    }

    return {
      ok: true,
      result
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || "telegram-error")
    };
  }
}

function readBool(url, body, key, fallback = false) {
  const value = url.searchParams.get(key) ?? body?.[key];

  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value) === "1" || String(value).toLowerCase() === "true";
}

function readNumber(url, body, key, fallback) {
  const raw = url.searchParams.get(key) ?? body?.[key] ?? fallback;
  const n = Number(raw);

  return Number.isFinite(n) ? n : fallback;
}

function normalizeTimeframe(value) {
  const timeframe = String(value || "").toUpperCase().trim();

  return ["M5", "M15", "H1", "H4"].includes(timeframe) ? timeframe : "";
}

function formatValue(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return "0";

  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 100) return n.toFixed(3);
  if (Math.abs(n) >= 10) return n.toFixed(4);

  return n.toFixed(5);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
