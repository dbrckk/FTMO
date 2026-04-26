const DEFAULT_PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

const OPTIONAL_COLUMNS = [
  ["setup_type", "TEXT"],
  ["setup_quality_score", "REAL"],
  ["entry_quality_score", "REAL"],
  ["exit_pressure_score", "REAL"],
  ["volatility_regime", "TEXT"],
  ["trend_regime", "TEXT"],
  ["model_tag", "TEXT"],
  ["sniper_score", "REAL"]
];

export async function ensureArchiveColumns(db) {
  if (!db) return;

  for (const [name, type] of OPTIONAL_COLUMNS) {
    try {
      await db.prepare(`ALTER TABLE paper_trades ADD COLUMN ${name} ${type}`).run();
    } catch {
      // Column already exists or table is not ready yet.
    }
  }
}

export async function getArchiveStatsMap(db, timeframe = "M15", pairs = DEFAULT_PAIRS) {
  const stats = {};

  await ensureArchiveColumns(db);

  for (const pair of pairs) {
    const intelligence = await buildArchiveIntelligence(db, {
      pair,
      timeframe
    });

    stats[pair] = toFrontendArchiveStats(pair, intelligence);
  }

  return stats;
}

export async function buildHistoricalEdgeGate(db, scan = {}, options = {}) {
  const mode = options.mode || "sniper";
  const pair = String(scan.pair || "").toUpperCase();
  const timeframe = String(scan.timeframe || "M15").toUpperCase();
  const direction = String(scan.direction || "").toLowerCase();
  const setupType = String(scan.setupType || scan.setup_type || "").trim();
  const session = String(scan.session || inferSession(new Date())).trim();
  const hour = Number.isFinite(Number(scan.hour)) ? Number(scan.hour) : inferHour(new Date());

  const intelligence = await buildArchiveIntelligence(db, {
    pair,
    timeframe,
    direction,
    setupType,
    session,
    hour
  });

  const profile = getGateProfile(pair, mode);
  const blockers = [];
  const warnings = [];

  const core = intelligence.core;
  const dir = intelligence.direction;
  const setup = intelligence.setup;
  const sessionStats = intelligence.session;
  const hourStats = intelligence.hour;

  if (core.trades >= profile.minPairTrades) {
    if (core.winRate < profile.minPairWinRate) {
      blockers.push(`Pair WR weak ${core.winRate.toFixed(1)}%`);
    }

    if (core.expectancy < profile.minPairExpectancy) {
      blockers.push(`Pair expectancy weak ${core.expectancy.toFixed(3)}R`);
    }
  } else {
    warnings.push(`Pair sample small ${core.trades}/${profile.minPairTrades}`);
  }

  if (dir.trades >= profile.minDirectionTrades) {
    if (dir.winRate < profile.minDirectionWinRate) {
      blockers.push(`Direction WR weak ${dir.winRate.toFixed(1)}%`);
    }

    if (dir.expectancy < profile.minDirectionExpectancy) {
      blockers.push(`Direction expectancy weak ${dir.expectancy.toFixed(3)}R`);
    }
  } else {
    warnings.push(`Direction sample small ${dir.trades}/${profile.minDirectionTrades}`);
  }

  if (setupType && setup.trades >= profile.minSetupTrades) {
    if (setup.winRate < profile.minSetupWinRate) {
      blockers.push(`Setup WR weak ${setup.winRate.toFixed(1)}%`);
    }

    if (setup.expectancy < profile.minSetupExpectancy) {
      blockers.push(`Setup expectancy weak ${setup.expectancy.toFixed(3)}R`);
    }
  } else if (setupType) {
    warnings.push(`Setup sample small ${setup.trades}/${profile.minSetupTrades}`);
  }

  if (sessionStats.trades >= profile.minSessionTrades) {
    if (sessionStats.winRate < profile.minSessionWinRate) {
      blockers.push(`Session WR weak ${sessionStats.winRate.toFixed(1)}%`);
    }

    if (sessionStats.expectancy < profile.minSessionExpectancy) {
      blockers.push(`Session expectancy weak ${sessionStats.expectancy.toFixed(3)}R`);
    }
  } else {
    warnings.push(`Session sample small ${sessionStats.trades}/${profile.minSessionTrades}`);
  }

  if (hourStats.trades >= profile.minHourTrades) {
    if (hourStats.winRate < profile.minHourWinRate) {
      warnings.push(`Hour WR weak ${hourStats.winRate.toFixed(1)}%`);
    }

    if (hourStats.expectancy < profile.minHourExpectancy) {
      warnings.push(`Hour expectancy weak ${hourStats.expectancy.toFixed(3)}R`);
    }
  }

  const technicalOverride =
    Number(scan.sniperScore || 0) >= profile.technicalOverrideSniper ||
    (
      Number(scan.ultraScore || 0) >= profile.technicalOverrideUltra &&
      Number(scan.entryQualityScore || 0) >= profile.technicalOverrideEntry &&
      Number(scan.mtfScore || 0) >= profile.technicalOverrideMtf
    );

  const hasEnoughCoreSample =
    core.trades >= profile.minPairTrades &&
    dir.trades >= profile.minDirectionTrades;

  const allowed =
    blockers.length === 0 &&
    (
      mode !== "sniper" ||
      hasEnoughCoreSample ||
      technicalOverride
    );

  const learningAllowed =
    blockers.length <= 1 &&
    Number(scan.entryQualityScore || 0) >= 60 &&
    Number(scan.exitPressureScore || 99) <= 72;

  const reason = allowed
    ? warnings.length
      ? `Historical edge accepted with warnings: ${warnings.join(" · ")}`
      : "Historical edge accepted."
    : blockers.length
      ? blockers.join(" · ")
      : "Historical sample too small for sniper alert.";

  return {
    allowed,
    learningAllowed,
    mode,
    edgeScore: intelligence.edgeScore,
    confidence: intelligence.confidence,
    reason,
    blockers,
    warnings,
    intelligence
  };
}

export async function buildArchiveIntelligence(db, filters = {}) {
  await ensureArchiveColumns(db);

  const columns = await getTableColumns(db, "paper_trades");

  const core = await queryStats(db, columns, {
    pair: filters.pair,
    timeframe: filters.timeframe
  });

  const direction = await queryStats(db, columns, {
    pair: filters.pair,
    timeframe: filters.timeframe,
    direction: filters.direction
  });

  const setup = columns.has("setup_type")
    ? await queryStats(db, columns, {
      pair: filters.pair,
      timeframe: filters.timeframe,
      direction: filters.direction,
      setupType: filters.setupType
    })
    : emptyStats();

  const session = await queryStats(db, columns, {
    pair: filters.pair,
    timeframe: filters.timeframe,
    direction: filters.direction,
    session: filters.session
  });

  const hour = await queryStats(db, columns, {
    pair: filters.pair,
    timeframe: filters.timeframe,
    direction: filters.direction,
    hour: filters.hour
  });

  const byDirection = await groupStats(db, columns, "direction", {
    pair: filters.pair,
    timeframe: filters.timeframe
  });

  const bySession = await groupStats(db, columns, "session", {
    pair: filters.pair,
    timeframe: filters.timeframe
  });

  const byHour = await groupStats(db, columns, "hour", {
    pair: filters.pair,
    timeframe: filters.timeframe
  });

  const bySetup = columns.has("setup_type")
    ? await groupStats(db, columns, "setup_type", {
      pair: filters.pair,
      timeframe: filters.timeframe
    })
    : [];

  const edgeScore = computeHistoricalEdgeScore({
    core,
    direction,
    setup,
    session,
    hour
  });

  const confidence = computeConfidence({
    core,
    direction,
    setup,
    session
  });

  const bestDirection = pickBest(byDirection);
  const bestSession = pickBest(bySession);
  const bestHour = pickBest(byHour);
  const bestSetup = pickBest(bySetup);

  return {
    filters,
    core,
    direction,
    setup,
    session,
    hour,
    byDirection,
    bySession,
    byHour,
    bySetup,
    bestDirection,
    bestSession,
    bestHour,
    bestSetup,
    edgeScore,
    confidence
  };
}

async function queryStats(db, columns, filters = {}) {
  const where = buildWhere(columns, filters);
  const sql = `
    SELECT
      COUNT(*) AS trades,
      SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
      ROUND(AVG(COALESCE(pnl_r, 0)), 5) AS expectancy,
      ROUND(SUM(COALESCE(pnl_r, 0)), 5) AS pnl_r,
      ROUND(AVG(COALESCE(ultra_score, 0)), 2) AS avg_ultra,
      ROUND(AVG(COALESCE(ml_score, 0)), 2) AS avg_ml,
      ROUND(AVG(COALESCE(vectorbt_score, 0)), 2) AS avg_vectorbt,
      ROUND(AVG(COALESCE(archive_edge_score, 0)), 2) AS avg_archive
      ${columns.has("setup_quality_score") ? ", ROUND(AVG(COALESCE(setup_quality_score, 0)), 2) AS avg_setup_quality" : ""}
      ${columns.has("entry_quality_score") ? ", ROUND(AVG(COALESCE(entry_quality_score, 0)), 2) AS avg_entry_quality" : ""}
      ${columns.has("exit_pressure_score") ? ", ROUND(AVG(COALESCE(exit_pressure_score, 0)), 2) AS avg_exit_pressure" : ""}
    FROM paper_trades
    ${where.sql}
  `;

  const row = await db.prepare(sql).bind(...where.bindings).first();

  return normalizeStats(row, columns);
}

async function groupStats(db, columns, groupBy, filters = {}) {
  if (!columns.has(groupBy)) return [];

  const where = buildWhere(columns, filters);
  const sql = `
    SELECT
      ${groupBy} AS group_key,
      COUNT(*) AS trades,
      SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
      ROUND(AVG(COALESCE(pnl_r, 0)), 5) AS expectancy,
      ROUND(SUM(COALESCE(pnl_r, 0)), 5) AS pnl_r
    FROM paper_trades
    ${where.sql}
    GROUP BY ${groupBy}
    HAVING trades > 0
    ORDER BY expectancy DESC, trades DESC
    LIMIT 24
  `;

  const res = await db.prepare(sql).bind(...where.bindings).all();
  const rows = Array.isArray(res.results) ? res.results : [];

  return rows.map((row) => {
    const stats = normalizeStats(row, columns);

    return {
      key: String(row.group_key ?? "unknown"),
      ...stats
    };
  });
}

function buildWhere(columns, filters = {}) {
  const clauses = [];
  const bindings = [];

  if (filters.pair) {
    clauses.push("pair = ?");
    bindings.push(String(filters.pair).toUpperCase());
  }

  if (filters.timeframe) {
    clauses.push("timeframe = ?");
    bindings.push(String(filters.timeframe).toUpperCase());
  }

  if (filters.direction) {
    clauses.push("direction = ?");
    bindings.push(String(filters.direction).toLowerCase());
  }

  if (filters.setupType && columns.has("setup_type")) {
    clauses.push("setup_type = ?");
    bindings.push(String(filters.setupType));
  }

  if (filters.session && columns.has("session")) {
    clauses.push("session = ?");
    bindings.push(String(filters.session));
  }

  if (Number.isFinite(Number(filters.hour)) && columns.has("hour")) {
    clauses.push("hour = ?");
    bindings.push(Number(filters.hour));
  }

  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    bindings
  };
}

async function getTableColumns(db, tableName) {
  try {
    const res = await db.prepare(`PRAGMA table_info(${tableName})`).all();
    const rows = Array.isArray(res.results) ? res.results : [];

    return new Set(rows.map((row) => String(row.name)));
  } catch {
    return new Set();
  }
}

function normalizeStats(row, columns) {
  const trades = Number(row?.trades || 0);
  const wins = Number(row?.wins || 0);
  const winRate = trades ? (wins / trades) * 100 : 50;

  return {
    trades,
    wins,
    losses: Math.max(0, trades - wins),
    winRate: round(winRate, 2),
    expectancy: Number(row?.expectancy || 0),
    pnlR: Number(row?.pnl_r || 0),
    avgUltra: Number(row?.avg_ultra || 0),
    avgMl: Number(row?.avg_ml || 0),
    avgVectorbt: Number(row?.avg_vectorbt || 0),
    avgArchive: Number(row?.avg_archive || 0),
    avgSetupQuality: columns.has("setup_quality_score") ? Number(row?.avg_setup_quality || 0) : 0,
    avgEntryQuality: columns.has("entry_quality_score") ? Number(row?.avg_entry_quality || 0) : 0,
    avgExitPressure: columns.has("exit_pressure_score") ? Number(row?.avg_exit_pressure || 0) : 0
  };
}

function emptyStats() {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 50,
    expectancy: 0,
    pnlR: 0,
    avgUltra: 0,
    avgMl: 0,
    avgVectorbt: 0,
    avgArchive: 0,
    avgSetupQuality: 0,
    avgEntryQuality: 0,
    avgExitPressure: 0
  };
}

function computeHistoricalEdgeScore(data) {
  const core = scoreStats(data.core, 0.36);
  const direction = scoreStats(data.direction, 0.28);
  const setup = scoreStats(data.setup, 0.18);
  const session = scoreStats(data.session, 0.12);
  const hour = scoreStats(data.hour, 0.06);

  return Math.round(clamp(core + direction + setup + session + hour, 1, 99));
}

function scoreStats(stats, weight) {
  const sampleFactor =
    stats.trades >= 50 ? 1 :
    stats.trades >= 25 ? 0.85 :
    stats.trades >= 12 ? 0.65 :
    stats.trades >= 5 ? 0.45 :
    0.25;

  const winScore = 50 + (stats.winRate - 50) * 1.15;
  const expectancyScore = 50 + stats.expectancy * 42;

  return clamp((winScore * 0.48 + expectancyScore * 0.52), 1, 99) * weight * sampleFactor + 50 * weight * (1 - sampleFactor);
}

function computeConfidence(data) {
  const total =
    Math.min(1, data.core.trades / 50) * 0.45 +
    Math.min(1, data.direction.trades / 25) * 0.30 +
    Math.min(1, data.setup.trades / 18) * 0.15 +
    Math.min(1, data.session.trades / 18) * 0.10;

  return Math.round(clamp(total * 100, 1, 100));
}

function pickBest(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;

  return [...rows].sort((a, b) => {
    const aScore = scoreStats(a, 1);
    const bScore = scoreStats(b, 1);

    if (bScore !== aScore) return bScore - aScore;
    return Number(b.trades || 0) - Number(a.trades || 0);
  })[0];
}

function toFrontendArchiveStats(pair, intelligence) {
  const directions = {};

  for (const row of intelligence.byDirection || []) {
    directions[String(row.key || "").toLowerCase()] = {
      trades: row.trades,
      wins: row.wins,
      winRate: row.winRate,
      expectancy: row.expectancy,
      pnlR: row.pnlR
    };
  }

  return {
    pair,
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

    directions,
    bestDirection: intelligence.bestDirection,
    bestSession: intelligence.bestSession,
    bestHour: intelligence.bestHour,
    bestSetup: intelligence.bestSetup,

    byDirection: intelligence.byDirection,
    bySession: intelligence.bySession,
    byHour: intelligence.byHour,
    bySetup: intelligence.bySetup
  };
}

function getGateProfile(pair, mode) {
  const p = String(pair || "").toUpperCase();

  const base = {
    minPairTrades: mode === "sniper" ? 8 : 4,
    minDirectionTrades: mode === "sniper" ? 4 : 2,
    minSetupTrades: mode === "sniper" ? 4 : 2,
    minSessionTrades: mode === "sniper" ? 5 : 2,
    minHourTrades: mode === "sniper" ? 3 : 2,

    minPairWinRate: 56,
    minDirectionWinRate: 58,
    minSetupWinRate: 58,
    minSessionWinRate: 54,
    minHourWinRate: 52,

    minPairExpectancy: -0.02,
    minDirectionExpectancy: 0,
    minSetupExpectancy: 0,
    minSessionExpectancy: -0.04,
    minHourExpectancy: -0.05,

    technicalOverrideSniper: 88,
    technicalOverrideUltra: 86,
    technicalOverrideEntry: 82,
    technicalOverrideMtf: 80
  };

  if (p === "BTCUSD") {
    return {
      ...base,
      minPairWinRate: 58,
      minDirectionWinRate: 60,
      minSetupWinRate: 60,
      technicalOverrideSniper: 90,
      technicalOverrideUltra: 88,
      technicalOverrideEntry: 84,
      technicalOverrideMtf: 82
    };
  }

  if (p === "XAUUSD") {
    return {
      ...base,
      minPairWinRate: 57,
      minDirectionWinRate: 59,
      minSetupWinRate: 59,
      technicalOverrideSniper: 89,
      technicalOverrideUltra: 87,
      technicalOverrideEntry: 83,
      technicalOverrideMtf: 81
    };
  }

  return base;
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
