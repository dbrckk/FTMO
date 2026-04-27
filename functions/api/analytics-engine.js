const MODEL_VERSION = "analytics-engine-v1";

export async function onRequestGet(context) {
  return handleAnalytics(context);
}

export async function onRequestPost(context) {
  return handleAnalytics(context);
}

async function handleAnalytics(context) {
  const startedAt = Date.now();

  try {
    const env = context.env || {};
    const db = env.DB;

    if (!db) {
      return json({
        ok: false,
        source: "analytics-engine",
        version: MODEL_VERSION,
        error: "Missing DB binding"
      }, 500);
    }

    if (!isAuthorized(context.request, env.SYNC_SECRET || "")) {
      return json({
        ok: false,
        source: "analytics-engine",
        version: MODEL_VERSION,
        error: "Unauthorized"
      }, 401);
    }

    await ensureAnalyticsTables(db);
    await importPaperTradesIntoLearning(db);

    const url = new URL(context.request.url);
    const minTrades = Number(url.searchParams.get("minTrades") || 8);

    const overall = await computeOverallStats(db);
    const byPair = await computeGroupedStats(db, "pair", minTrades);
    const bySetup = await computeGroupedStats(db, "setup_type", minTrades);
    const bySession = await computeGroupedStats(db, "session", minTrades);
    const byHour = await computeGroupedStats(db, "hour", minTrades);
    const bySource = await computeGroupedStats(db, "source", 1);
    const byDirection = await computeGroupedStats(db, "direction", minTrades);
    const byPairDirection = await computePairDirectionStats(db, minTrades);
    const scoreBuckets = await computeScoreBuckets(db, minTrades);

    const recommendations = buildRecommendations({
      byPair,
      bySetup,
      bySession,
      byHour,
      byPairDirection,
      scoreBuckets,
      minTrades
    });

    await saveAnalyticsSnapshot(db, {
      overall,
      byPair,
      bySetup,
      bySession,
      byHour,
      bySource,
      byDirection,
      byPairDirection,
      scoreBuckets,
      recommendations
    });

    return json({
      ok: true,
      source: "analytics-engine",
      version: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      minTrades,
      overall,
      leaderboard: {
        bestPairs: byPair.slice(0, 10),
        bestSetups: bySetup.slice(0, 10),
        bestSessions: bySession.slice(0, 10),
        bestHours: byHour.slice(0, 10),
        bestPairDirections: byPairDirection.slice(0, 15),
        scoreBuckets
      },
      weakZones: {
        worstPairs: byPair.slice().reverse().slice(0, 10),
        worstSetups: bySetup.slice().reverse().slice(0, 10),
        worstHours: byHour.slice().reverse().slice(0, 10)
      },
      bySource,
      byDirection,
      recommendations
    });
  } catch (error) {
    return json({
      ok: false,
      source: "analytics-engine",
      version: MODEL_VERSION,
      error: String(error?.message || error || "analytics-engine-error")
    }, 500);
  }
}

async function ensureAnalyticsTables(db) {
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

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS analytics_snapshots (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      model_version TEXT,
      total_trades INTEGER,
      win_rate REAL,
      expectancy_r REAL,
      net_pnl REAL,
      profit_factor REAL,
      max_drawdown REAL,
      payload_json TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS model_rules (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      target TEXT NOT NULL,
      action TEXT NOT NULL,
      confidence REAL,
      reason TEXT,
      payload_json TEXT
    )
  `).run();
}

async function importPaperTradesIntoLearning(db) {
  try {
    const res = await db.prepare(`
      SELECT
        id,
        pair,
        timeframe,
        direction,
        opened_at,
        closed_at,
        entry,
        exit,
        pnl,
        pnl_r,
        win,
        session,
        hour,
        ultra_score,
        archive_edge_score,
        setup_type,
        entry_quality_score,
        exit_pressure_score,
        close_reason,
        source
      FROM paper_trades
      ORDER BY closed_at DESC
      LIMIT 5000
    `).all();

    const rows = Array.isArray(res.results) ? res.results : [];

    for (const row of rows) {
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
        `paper_${row.id}`,
        "paper",
        row.id,
        "paper-account",
        normalizePair(row.pair),
        row.timeframe || "M15",
        row.direction || "",
        row.opened_at || null,
        row.closed_at || null,
        Number(row.entry || 0),
        Number(row.exit || 0),
        0,
        Number(row.pnl || 0),
        Number(row.pnl_r || 0),
        Number(row.win || 0),
        row.setup_type || "unknown",
        row.session || inferSession(row.closed_at),
        Number(row.hour || inferHour(row.closed_at)),
        Number(row.ultra_score || 0),
        Number(row.entry_quality_score || 0),
        Number(row.exit_pressure_score || 0),
        Number(row.archive_edge_score || 0),
        row.close_reason || "",
        JSON.stringify(row),
        new Date().toISOString()
      ).run();
    }
  } catch {
    // No paper_trades yet.
  }
}

async function computeOverallStats(db) {
  const rows = await getLearningRows(db);

  return buildStats("overall", "all", rows);
}

async function computeGroupedStats(db, field, minTrades) {
  const rows = await getLearningRows(db);
  const groups = new Map();

  for (const row of rows) {
    const key = String(row[field] ?? "unknown");

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()]
    .map(([key, groupRows]) => buildStats(field, key, groupRows))
    .filter((item) => item.trades >= minTrades)
    .sort(sortStats);
}

async function computePairDirectionStats(db, minTrades) {
  const rows = await getLearningRows(db);
  const groups = new Map();

  for (const row of rows) {
    const key = `${normalizePair(row.pair)}_${String(row.direction || "unknown").toLowerCase()}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()]
    .map(([key, groupRows]) => buildStats("pair_direction", key, groupRows))
    .filter((item) => item.trades >= minTrades)
    .sort(sortStats);
}

async function computeScoreBuckets(db, minTrades) {
  const rows = await getLearningRows(db);
  const groups = new Map();

  for (const row of rows) {
    const score = Number(row.score || 0);
    const bucket =
      score >= 90 ? "90-100" :
      score >= 80 ? "80-89" :
      score >= 70 ? "70-79" :
      score >= 60 ? "60-69" :
      score >= 50 ? "50-59" :
      "0-49";

    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(row);
  }

  return [...groups.entries()]
    .map(([key, groupRows]) => buildStats("score_bucket", key, groupRows))
    .filter((item) => item.trades >= minTrades)
    .sort((a, b) => String(b.key).localeCompare(String(a.key)));
}

async function getLearningRows(db) {
  const res = await db.prepare(`
    SELECT
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
      notes
    FROM learning_trades
    ORDER BY closed_at DESC
    LIMIT 10000
  `).all();

  return Array.isArray(res.results)
    ? res.results.map((row) => ({
      ...row,
      pair: normalizePair(row.pair),
      pnl: Number(row.pnl || 0),
      pnl_r: Number(row.pnl_r || 0),
      win: Number(row.win || 0),
      score: Number(row.score || 0),
      entry_quality_score: Number(row.entry_quality_score || 0),
      exit_pressure_score: Number(row.exit_pressure_score || 0),
      archive_edge_score: Number(row.archive_edge_score || 0),
      hour: Number(row.hour || 0)
    }))
    : [];
}

function buildStats(type, key, rows) {
  const trades = rows.length;
  const wins = rows.filter((row) => Number(row.win || 0) === 1).length;
  const losses = trades - wins;

  const pnlValues = rows.map((row) => Number(row.pnl || 0));
  const rValues = rows.map((row) => Number(row.pnl_r || 0));
  const positiveR = rValues.filter((value) => value > 0);
  const negativeR = rValues.filter((value) => value <= 0);

  const grossProfit = pnlValues.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnlValues.filter((v) => v < 0).reduce((a, b) => a + b, 0));

  const netPnl = pnlValues.reduce((a, b) => a + b, 0);
  const totalR = rValues.reduce((a, b) => a + b, 0);

  const expectancyR = trades ? totalR / trades : 0;
  const avgWinR = positiveR.length ? average(positiveR) : 0;
  const avgLossR = negativeR.length ? average(negativeR) : 0;

  return {
    type,
    key,
    trades,
    wins,
    losses,
    winRate: percent(wins, trades),
    netPnl: round(netPnl, 2),
    totalR: round(totalR, 3),
    expectancyR: round(expectancyR, 3),
    avgR: round(expectancyR, 3),
    avgWinR: round(avgWinR, 3),
    avgLossR: round(avgLossR, 3),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 3) : grossProfit > 0 ? 99 : 0,
    maxDrawdown: round(maxDrawdown(pnlValues), 2),
    score: scoreStats({ trades, winRate: percent(wins, trades), expectancyR, profitFactor: grossLoss > 0 ? grossProfit / grossLoss : 0 })
  };
}

function buildRecommendations(data) {
  const rules = [];

  for (const setup of data.bySetup) {
    if (setup.trades >= data.minTrades && setup.expectancyR <= -0.15) {
      rules.push({
        type: "setup_type",
        target: setup.key,
        action: "block_or_reduce",
        confidence: confidenceFromTrades(setup.trades),
        reason: `Negative expectancy: ${setup.expectancyR}R over ${setup.trades} trades`
      });
    }

    if (setup.trades >= data.minTrades && setup.expectancyR >= 0.15 && setup.profitFactor >= 1.3) {
      rules.push({
        type: "setup_type",
        target: setup.key,
        action: "boost",
        confidence: confidenceFromTrades(setup.trades),
        reason: `Positive expectancy: ${setup.expectancyR}R, PF ${setup.profitFactor}`
      });
    }
  }

  for (const pair of data.byPair) {
    if (pair.trades >= data.minTrades && pair.expectancyR <= -0.12) {
      rules.push({
        type: "pair",
        target: pair.key,
        action: "reduce_or_disable",
        confidence: confidenceFromTrades(pair.trades),
        reason: `Weak pair performance: ${pair.expectancyR}R`
      });
    }

    if (pair.trades >= data.minTrades && pair.expectancyR >= 0.12 && pair.profitFactor >= 1.25) {
      rules.push({
        type: "pair",
        target: pair.key,
        action: "allow_boost",
        confidence: confidenceFromTrades(pair.trades),
        reason: `Strong pair performance: ${pair.expectancyR}R`
      });
    }
  }

  for (const hour of data.byHour) {
    if (hour.trades >= data.minTrades && hour.expectancyR <= -0.15) {
      rules.push({
        type: "hour",
        target: String(hour.key),
        action: "avoid",
        confidence: confidenceFromTrades(hour.trades),
        reason: `Bad trading hour: ${hour.key}h, expectancy ${hour.expectancyR}R`
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    rules: rules
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
      .slice(0, 100)
  };
}

async function saveAnalyticsSnapshot(db, payload) {
  const overall = payload.overall || {};

  await db.prepare(`
    INSERT INTO analytics_snapshots (
      id,
      created_at,
      model_version,
      total_trades,
      win_rate,
      expectancy_r,
      net_pnl,
      profit_factor,
      max_drawdown,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    `analytics_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    new Date().toISOString(),
    MODEL_VERSION,
    Number(overall.trades || 0),
    Number(overall.winRate || 0),
    Number(overall.expectancyR || 0),
    Number(overall.netPnl || 0),
    Number(overall.profitFactor || 0),
    Number(overall.maxDrawdown || 0),
    JSON.stringify(payload)
  ).run();

  for (const rule of payload.recommendations?.rules || []) {
    await db.prepare(`
      INSERT OR REPLACE INTO model_rules (
        id,
        created_at,
        rule_type,
        target,
        action,
        confidence,
        reason,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      `${rule.type}_${rule.target}`,
      new Date().toISOString(),
      rule.type,
      String(rule.target),
      rule.action,
      Number(rule.confidence || 0),
      rule.reason,
      JSON.stringify(rule)
    ).run();
  }
}

function scoreStats(data) {
  let score = 50;

  score += Math.min(20, Number(data.trades || 0) * 0.5);
  score += (Number(data.winRate || 0) - 50) * 0.35;
  score += Number(data.expectancyR || 0) * 45;
  score += (Number(data.profitFactor || 0) - 1) * 12;

  return round(clamp(score, 0, 100), 1);
}

function sortStats(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.expectancyR !== a.expectancyR) return b.expectancyR - a.expectancyR;
  return b.trades - a.trades;
}

function confidenceFromTrades(trades) {
  const n = Number(trades || 0);

  if (n >= 100) return 95;
  if (n >= 60) return 85;
  if (n >= 40) return 75;
  if (n >= 25) return 65;
  if (n >= 15) return 50;

  return 35;
}

function maxDrawdown(values) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;

  for (const value of values) {
    equity += Number(value || 0);
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
  }

  return maxDd;
}

function normalizePair(pair) {
  return String(pair || "")
    .toUpperCase()
    .replaceAll(".", "")
    .replaceAll("_", "")
    .replaceAll("-", "")
    .trim();
}

function inferSession(value) {
  const hour = inferHour(value);

  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const tokyo = hour >= 1 && hour < 10;

  if (london && newYork) return "London+NewYork";
  if (london) return "London";
  if (newYork) return "NewYork";
  if (tokyo) return "Tokyo";

  return "OffSession";
}

function inferHour(value) {
  const date = value ? new Date(value) : new Date();

  return Number(
    date.toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );
}

function average(values) {
  if (!values.length) return 0;

  return values.reduce((a, b) => a + Number(b || 0), 0) / values.length;
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

function clamp(value, min, max) {
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
  }
