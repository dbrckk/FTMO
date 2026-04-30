const MODEL_RULES_VERSION = "model-rules-v1";

const DEFAULT_CONFIG = {
  minConfidence: 45,
  maxPenalty: 18,
  maxBoost: 12,
  hardBlockConfidence: 70,
  hardBlockNegativeExpectancy: -0.2,
  reduceNegativeExpectancy: -0.08,
  boostPositiveExpectancy: 0.12
};

export async function applyModelRulesToScans(db, scans = [], options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...(options.config || {})
  };

  if (!db || !Array.isArray(scans) || !scans.length) {
    return scans;
  }

  const rules = await loadModelRules(db, config);

  if (!rules.length) {
    return scans.map((scan) => ({
      ...scan,
      modelRulesVersion: MODEL_RULES_VERSION,
      modelRulesApplied: 0,
      modelRulesScoreDelta: 0,
      modelRulesReasons: []
    }));
  }

  return scans.map((scan) => applyRulesToSingleScan(scan, rules, config));
}

export async function loadModelRules(db, config = DEFAULT_CONFIG) {
  try {
    await ensureModelRulesTable(db);

    const res = await db.prepare(`
      SELECT
        id,
        created_at,
        rule_type,
        target,
        action,
        confidence,
        reason,
        payload_json
      FROM model_rules
      WHERE confidence >= ?
      ORDER BY confidence DESC, created_at DESC
      LIMIT 300
    `).bind(Number(config.minConfidence || 45)).all();

    const rows = Array.isArray(res.results) ? res.results : [];

    return rows
      .map(normalizeRule)
      .filter((rule) => rule.ruleType && rule.target && rule.action);
  } catch {
    return [];
  }
}

export async function ensureModelRulesTable(db) {
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

function applyRulesToSingleScan(scan, rules, config) {
  if (!scan || typeof scan !== "object") return scan;

  const matched = rules.filter((rule) => ruleMatchesScan(rule, scan));

  if (!matched.length) {
    return {
      ...scan,
      modelRulesVersion: MODEL_RULES_VERSION,
      modelRulesApplied: 0,
      modelRulesScoreDelta: 0,
      modelRulesReasons: []
    };
  }

  let scoreDelta = 0;
  let blocked = false;
  const reasons = [];

  for (const rule of matched) {
    const impact = computeRuleImpact(rule, config);

    scoreDelta += impact.scoreDelta;

    if (impact.blocked) {
      blocked = true;
    }

    reasons.push({
      rule: rule.id,
      type: rule.ruleType,
      target: rule.target,
      action: rule.action,
      confidence: rule.confidence,
      scoreDelta: impact.scoreDelta,
      blocked: impact.blocked,
      reason: rule.reason
    });
  }

  scoreDelta = clamp(scoreDelta, -Number(config.maxPenalty || 18), Number(config.maxBoost || 12));

  const currentPaperScore = Number(scan.paperScore || 0);
  const currentUltraScore = Number(scan.ultraScore || 0);
  const currentEntryScore = Number(scan.entryQualityScore || 0);

  const adjustedPaperScore = clampScore(currentPaperScore + scoreDelta);
  const adjustedUltraScore = clampScore(currentUltraScore + scoreDelta * 0.45);
  const adjustedEntryScore = clampScore(currentEntryScore + scoreDelta * 0.35);

  const wasAllowed = scan.tradeAllowed !== false;
  const nowAllowed = Boolean(wasAllowed && !blocked && adjustedPaperScore >= 50);

  return {
    ...scan,

    paperScore: Math.round(adjustedPaperScore),
    ultraScore: Math.round(adjustedUltraScore),
    entryQualityScore: Math.round(adjustedEntryScore),

    tradeAllowed: nowAllowed,
    tradeStatus: nowAllowed ? scan.tradeStatus : "BLOCKED_BY_MODEL_RULES",
    tradeReason: nowAllowed
      ? `${scan.tradeReason || "Accepted"} Model rules: ${formatRuleSummary(reasons)}`
      : `Model rules blocked/reduced this setup: ${formatRuleSummary(reasons)}`,

    modelRulesVersion: MODEL_RULES_VERSION,
    modelRulesApplied: matched.length,
    modelRulesScoreDelta: Number(scoreDelta.toFixed(2)),
    modelRulesReasons: reasons
  };
}

function ruleMatchesScan(rule, scan) {
  const ruleType = String(rule.ruleType || "").toLowerCase();
  const target = normalizeTarget(rule.target);

  const pair = normalizePair(scan.pair);
  const direction = normalizeText(scan.direction);
  const setupType = normalizeText(scan.setupType);
  const session = normalizeText(scan.session);
  const hour = String(scan.hour ?? inferHour()).trim();

  if (ruleType === "pair") {
    return normalizeTarget(pair) === target;
  }

  if (ruleType === "setup_type") {
    return normalizeTarget(setupType) === target;
  }

  if (ruleType === "direction") {
    return normalizeTarget(direction) === target;
  }

  if (ruleType === "session") {
    return normalizeTarget(session) === target;
  }

  if (ruleType === "hour") {
    return normalizeTarget(hour) === target;
  }

  if (ruleType === "pair_direction") {
    return normalizeTarget(`${pair}_${direction}`) === target;
  }

  if (ruleType === "score_bucket") {
    return normalizeTarget(getScoreBucket(scan.paperScore || scan.ultraScore || 0)) === target;
  }

  return false;
}

function computeRuleImpact(rule, config) {
  const action = String(rule.action || "").toLowerCase();
  const confidence = Number(rule.confidence || 0);
  const strength = clamp(confidence / 100, 0.25, 1);

  const payload = parsePayload(rule.payloadJson);
  const expectancyR = Number(
    payload.expectancyR ??
    payload.expectancy_r ??
    payload.expectancy ??
    0
  );

  let scoreDelta = 0;
  let blocked = false;

  if (action.includes("block")) {
    scoreDelta -= 14 * strength;

    if (
      confidence >= Number(config.hardBlockConfidence || 70) &&
      expectancyR <= Number(config.hardBlockNegativeExpectancy || -0.2)
    ) {
      blocked = true;
    }
  } else if (action.includes("reduce") || action.includes("avoid") || action.includes("disable")) {
    scoreDelta -= 9 * strength;

    if (
      confidence >= 80 &&
      expectancyR <= Number(config.hardBlockNegativeExpectancy || -0.2)
    ) {
      blocked = true;
    }
  } else if (action.includes("boost") || action.includes("allow")) {
    scoreDelta += 7 * strength;

    if (expectancyR >= 0.25 && confidence >= 70) {
      scoreDelta += 3;
    }
  }

  if (expectancyR <= Number(config.reduceNegativeExpectancy || -0.08)) {
    scoreDelta -= Math.min(6, Math.abs(expectancyR) * 18) * strength;
  }

  if (expectancyR >= Number(config.boostPositiveExpectancy || 0.12)) {
    scoreDelta += Math.min(5, expectancyR * 14) * strength;
  }

  return {
    scoreDelta: Number(scoreDelta.toFixed(2)),
    blocked
  };
}

function normalizeRule(row) {
  return {
    id: String(row.id || ""),
    createdAt: row.created_at || null,
    ruleType: String(row.rule_type || "").toLowerCase().trim(),
    target: String(row.target || "").trim(),
    action: String(row.action || "").toLowerCase().trim(),
    confidence: Number(row.confidence || 0),
    reason: String(row.reason || "").trim(),
    payloadJson: row.payload_json || ""
  };
}

function parsePayload(value) {
  try {
    if (!value) return {};

    const parsed = JSON.parse(value);

    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function formatRuleSummary(reasons) {
  if (!Array.isArray(reasons) || !reasons.length) {
    return "no rule";
  }

  return reasons
    .slice(0, 4)
    .map((item) => `${item.type}:${item.target}:${item.action}:${item.scoreDelta}`)
    .join(" | ");
}

function getScoreBucket(score) {
  const value = Number(score || 0);

  if (value >= 90) return "90-100";
  if (value >= 80) return "80-89";
  if (value >= 70) return "70-79";
  if (value >= 60) return "60-69";
  if (value >= 50) return "50-59";

  return "0-49";
}

function normalizePair(value) {
  return String(value || "")
    .toUpperCase()
    .replaceAll(".", "")
    .replaceAll("_", "")
    .replaceAll("-", "")
    .trim();
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .trim();
}

function normalizeTarget(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll(" ", "")
    .trim();
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

function clampScore(value) {
  return clamp(Number(value || 0), 0, 99);
}

function clamp(value, min, max) {
  const n = Number(value);

  if (!Number.isFinite(n)) return min;

  return Math.max(min, Math.min(max, n));
  }
