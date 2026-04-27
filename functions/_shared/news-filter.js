const NEWS_FILTER_VERSION = "news-filter-v1";

const DEFAULT_HIGH_IMPACT_KEYWORDS = [
  "cpi",
  "inflation",
  "nfp",
  "non farm",
  "non-farm",
  "payroll",
  "fomc",
  "fed",
  "powell",
  "interest rate",
  "rate decision",
  "monetary policy",
  "ecb",
  "lagarde",
  "boe",
  "boj",
  "pmi",
  "unemployment",
  "jobless",
  "gdp",
  "retail sales",
  "ppi",
  "core pce",
  "consumer confidence"
];

const DEFAULT_BLOCK_BEFORE_MINUTES = 75;
const DEFAULT_BLOCK_AFTER_MINUTES = 45;
const DEFAULT_MEDIUM_BEFORE_MINUTES = 30;
const DEFAULT_MEDIUM_AFTER_MINUTES = 20;

export async function applyNewsFilterToScans(db, scans, options = {}) {
  await ensureNewsTables(db);

  const env = options.env || {};
  const now = options.now ? new Date(options.now) : new Date();

  const events = await getRelevantNewsEvents(db, env, now);

  return (scans || []).map((scan) => {
    const risk = evaluateNewsRiskForScan(scan, events, now);

    const blocked = risk.blocked;

    return {
      ...scan,

      newsFilter: risk,
      newsAllowed: !blocked,
      newsRiskLevel: risk.riskLevel,
      newsReason: risk.reason,

      tradeAllowed: Boolean(scan?.tradeAllowed && !blocked),
      tradeReason: blocked
        ? `News blocked: ${risk.reason}`
        : `${scan?.tradeReason || "Accepted"} News: ${risk.reason}`,

      paperScore: blocked
        ? Math.max(0, Number(scan?.paperScore || 0) - 22)
        : risk.riskLevel === "caution"
          ? Math.max(0, Number(scan?.paperScore || 0) - 6)
          : Number(scan?.paperScore || 0)
    };
  });
}

export async function evaluateNewsRisk(db, scan, options = {}) {
  await ensureNewsTables(db);

  const env = options.env || {};
  const now = options.now ? new Date(options.now) : new Date();
  const events = await getRelevantNewsEvents(db, env, now);

  return evaluateNewsRiskForScan(scan, events, now);
}

export async function ensureNewsTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS news_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      currency TEXT NOT NULL,
      impact TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT,
      blackout_before_minutes INTEGER,
      blackout_after_minutes INTEGER,
      active INTEGER DEFAULT 1
    )
  `).run();

  await addColumnIfMissing(db, "news_events", "source", "TEXT");
  await addColumnIfMissing(db, "news_events", "blackout_before_minutes", "INTEGER");
  await addColumnIfMissing(db, "news_events", "blackout_after_minutes", "INTEGER");
  await addColumnIfMissing(db, "news_events", "active", "INTEGER DEFAULT 1");
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

export async function insertNewsEvent(db, event) {
  await ensureNewsTables(db);

  const id =
    event.id ||
    `news_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const impact = normalizeImpact(event.impact || event.importance || "high");
  const title = String(event.title || event.name || "News event").trim();
  const currency = normalizeCurrency(event.currency || "USD");

  const startsAt = new Date(event.startsAt || event.starts_at || event.date || Date.now());

  if (!Number.isFinite(startsAt.getTime())) {
    throw new Error("Invalid startsAt date");
  }

  const before = Number(
    event.blackoutBeforeMinutes ??
    event.blackout_before_minutes ??
    getDefaultBeforeMinutes(impact, title)
  );

  const after = Number(
    event.blackoutAfterMinutes ??
    event.blackout_after_minutes ??
    getDefaultAfterMinutes(impact, title)
  );

  await db.prepare(`
    INSERT OR REPLACE INTO news_events (
      id,
      created_at,
      starts_at,
      currency,
      impact,
      title,
      source,
      blackout_before_minutes,
      blackout_after_minutes,
      active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    new Date().toISOString(),
    startsAt.toISOString(),
    currency,
    impact,
    title,
    String(event.source || "manual"),
    before,
    after,
    Number(event.active ?? 1)
  ).run();

  return {
    id,
    startsAt: startsAt.toISOString(),
    currency,
    impact,
    title,
    source: String(event.source || "manual"),
    blackoutBeforeMinutes: before,
    blackoutAfterMinutes: after,
    active: Number(event.active ?? 1)
  };
}

export async function listNewsEvents(db, options = {}) {
  await ensureNewsTables(db);

  const now = options.now ? new Date(options.now) : new Date();
  const from = new Date(now.getTime() - Number(options.pastHours || 12) * 60 * 60 * 1000);
  const to = new Date(now.getTime() + Number(options.futureHours || 72) * 60 * 60 * 1000);

  const res = await db.prepare(`
    SELECT
      id,
      starts_at,
      currency,
      impact,
      title,
      source,
      blackout_before_minutes,
      blackout_after_minutes,
      active
    FROM news_events
    WHERE starts_at >= ?
      AND starts_at <= ?
    ORDER BY starts_at ASC
    LIMIT 200
  `).bind(
    from.toISOString(),
    to.toISOString()
  ).all();

  return Array.isArray(res.results)
    ? res.results.map(normalizeDbEvent)
    : [];
}

async function getRelevantNewsEvents(db, env, now) {
  const dbEvents = await listNewsEvents(db, {
    now,
    pastHours: 12,
    futureHours: 72
  });

  const envEvents = parseEnvNewsEvents(env);

  return [...dbEvents, ...envEvents]
    .filter((event) => Number(event.active ?? 1) === 1)
    .filter((event) => {
      const startsAt = new Date(event.startsAt);
      return Number.isFinite(startsAt.getTime());
    });
}

function parseEnvNewsEvents(env = {}) {
  const raw =
    env.NEWS_EVENTS_JSON ||
    env.FTMO_NEWS_EVENTS_JSON ||
    "";

  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];

    return list.map((event, index) => {
      const impact = normalizeImpact(event.impact || event.importance || "high");
      const title = String(event.title || event.name || "News event").trim();

      return {
        id: event.id || `env_news_${index}`,
        startsAt: new Date(event.startsAt || event.starts_at || event.date).toISOString(),
        currency: normalizeCurrency(event.currency || "USD"),
        impact,
        title,
        source: event.source || "env",
        blackoutBeforeMinutes: Number(
          event.blackoutBeforeMinutes ??
          event.blackout_before_minutes ??
          getDefaultBeforeMinutes(impact, title)
        ),
        blackoutAfterMinutes: Number(
          event.blackoutAfterMinutes ??
          event.blackout_after_minutes ??
          getDefaultAfterMinutes(impact, title)
        ),
        active: Number(event.active ?? 1)
      };
    });
  } catch {
    return [];
  }
}

function evaluateNewsRiskForScan(scan, events, now) {
  const pair = String(scan?.pair || "").toUpperCase();
  const signal = String(scan?.signal || "WAIT").toUpperCase();

  if (!pair || signal === "WAIT") {
    return {
      version: NEWS_FILTER_VERSION,
      allowed: true,
      blocked: false,
      riskLevel: "none",
      reason: "No active trade signal.",
      pair,
      currencies: [],
      activeEvents: [],
      upcomingEvents: []
    };
  }

  const currencies = getPairCurrencies(pair);
  const activeEvents = [];
  const upcomingEvents = [];
  const blockers = [];
  const warnings = [];

  for (const event of events || []) {
    if (!isEventRelevantForPair(event, currencies, pair)) continue;

    const eventTime = new Date(event.startsAt);
    const diffMinutes = (eventTime.getTime() - now.getTime()) / 60000;

    const before = Number(event.blackoutBeforeMinutes || getDefaultBeforeMinutes(event.impact, event.title));
    const after = Number(event.blackoutAfterMinutes || getDefaultAfterMinutes(event.impact, event.title));

    const insideBlackout =
      diffMinutes <= before &&
      diffMinutes >= -after;

    const upcoming =
      diffMinutes > before &&
      diffMinutes <= before + 180;

    const normalized = {
      id: event.id,
      title: event.title,
      currency: event.currency,
      impact: event.impact,
      startsAt: event.startsAt,
      minutesToEvent: Math.round(diffMinutes),
      blackoutBeforeMinutes: before,
      blackoutAfterMinutes: after,
      source: event.source || ""
    };

    if (insideBlackout) {
      activeEvents.push(normalized);

      if (isHighImpact(event)) {
        blockers.push(`${event.currency} ${event.title} in blackout window`);
      } else {
        warnings.push(`${event.currency} ${event.title} medium-impact blackout`);
      }
    } else if (upcoming) {
      upcomingEvents.push(normalized);

      if (isHighImpact(event)) {
        warnings.push(`${event.currency} ${event.title} upcoming`);
      }
    }
  }

  const blocked = blockers.length > 0;
  const riskLevel =
    blocked ? "blocked" :
    warnings.length > 0 ? "caution" :
    upcomingEvents.length > 0 ? "watch" :
    "clear";

  return {
    version: NEWS_FILTER_VERSION,
    allowed: !blocked,
    blocked,
    riskLevel,
    reason:
      blocked ? blockers.join(" · ") :
      warnings.length ? warnings.join(" · ") :
      upcomingEvents.length ? "Relevant news later today." :
      "No dangerous news window.",
    pair,
    currencies,
    blockers,
    warnings,
    activeEvents,
    upcomingEvents
  };
}

function normalizeDbEvent(row) {
  return {
    id: row.id,
    startsAt: row.starts_at,
    currency: normalizeCurrency(row.currency),
    impact: normalizeImpact(row.impact),
    title: row.title || "News event",
    source: row.source || "",
    blackoutBeforeMinutes: Number(row.blackout_before_minutes || getDefaultBeforeMinutes(row.impact, row.title)),
    blackoutAfterMinutes: Number(row.blackout_after_minutes || getDefaultAfterMinutes(row.impact, row.title)),
    active: Number(row.active ?? 1)
  };
}

function getPairCurrencies(pair) {
  const p = String(pair || "").toUpperCase();

  if (p === "XAUUSD") return ["XAU", "USD"];
  if (p === "BTCUSD") return ["BTC", "USD"];

  if (p.length >= 6) {
    return [p.slice(0, 3), p.slice(3, 6)];
  }

  return [p];
}

function isEventRelevantForPair(event, currencies, pair) {
  const currency = normalizeCurrency(event.currency);

  if (currency === "ALL") return true;
  if (currency === "GLOBAL") return true;

  if (pair === "XAUUSD" && currency === "USD") return true;
  if (pair === "BTCUSD" && currency === "USD") return true;

  return currencies.includes(currency);
}

function isHighImpact(event) {
  const impact = normalizeImpact(event.impact);
  const title = String(event.title || "").toLowerCase();

  if (impact === "high" || impact === "red") return true;

  return DEFAULT_HIGH_IMPACT_KEYWORDS.some((keyword) => title.includes(keyword));
}

function getDefaultBeforeMinutes(impact, title = "") {
  if (isKeywordHighRisk(title)) return 90;

  const normalized = normalizeImpact(impact);

  if (normalized === "high" || normalized === "red") return DEFAULT_BLOCK_BEFORE_MINUTES;
  if (normalized === "medium" || normalized === "orange") return DEFAULT_MEDIUM_BEFORE_MINUTES;

  return 15;
}

function getDefaultAfterMinutes(impact, title = "") {
  if (isKeywordHighRisk(title)) return 75;

  const normalized = normalizeImpact(impact);

  if (normalized === "high" || normalized === "red") return DEFAULT_BLOCK_AFTER_MINUTES;
  if (normalized === "medium" || normalized === "orange") return DEFAULT_MEDIUM_AFTER_MINUTES;

  return 10;
}

function isKeywordHighRisk(title = "") {
  const lower = String(title || "").toLowerCase();

  return DEFAULT_HIGH_IMPACT_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function normalizeImpact(value) {
  const text = String(value || "").toLowerCase().trim();

  if (["high", "red", "3", "important"].includes(text)) return "high";
  if (["medium", "orange", "2", "moderate"].includes(text)) return "medium";
  if (["low", "yellow", "1"].includes(text)) return "low";

  return text || "high";
}

function normalizeCurrency(value) {
  return String(value || "USD").toUpperCase().trim();
                   }
