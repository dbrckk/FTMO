const MAX_TOTAL_RISK_PERCENT = 3;
const MAX_SINGLE_GROUP_RISK_PERCENT = 1.5;
const MAX_CRYPTO_RISK_PERCENT = 0.75;
const MAX_GOLD_RISK_PERCENT = 1;

export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const positions = Array.isArray(body.positions) ? body.positions : [];

    const normalized = positions
      .map(normalizePosition)
      .filter(Boolean);

    const totalRisk = normalized.reduce(
      (sum, position) => sum + Number(position.riskPercent || 0),
      0
    );

    const groups = buildRiskGroups(normalized);
    const warnings = [];

    if (totalRisk > MAX_TOTAL_RISK_PERCENT) {
      warnings.push(`Total risk too high: ${round(totalRisk)}%.`);
    }

    for (const group of groups) {
      if (group.name === "BTC_USD" && group.riskPercent > MAX_CRYPTO_RISK_PERCENT) {
        warnings.push(`BTC risk too high: ${round(group.riskPercent)}%.`);
      } else if (group.name === "GOLD_USD" && group.riskPercent > MAX_GOLD_RISK_PERCENT) {
        warnings.push(`Gold risk too high: ${round(group.riskPercent)}%.`);
      } else if (
        group.name !== "BTC_USD" &&
        group.name !== "GOLD_USD" &&
        group.riskPercent > MAX_SINGLE_GROUP_RISK_PERCENT
      ) {
        warnings.push(`${group.name} exposure too high: ${round(group.riskPercent)}%.`);
      }
    }

    const cryptoExposure = groups.find((group) => group.name === "BTC_USD") || null;
    const goldExposure = groups.find((group) => group.name === "GOLD_USD") || null;

    const decision = warnings.length ? "REDUCE" : "OK";

    return json({
      ok: true,
      source: "portfolio-risk",
      version: "portfolio-risk-btc-v2",
      decision,
      totalRiskPercent: round(totalRisk),
      maxTotalRiskPercent: MAX_TOTAL_RISK_PERCENT,
      positionsCount: normalized.length,
      warnings,
      groups,
      cryptoExposure,
      goldExposure,
      reason: warnings.length
        ? warnings.join(" ")
        : "Portfolio risk is within configured limits."
    });
  } catch (error) {
    return json({
      ok: false,
      decision: "REDUCE",
      error: String(error?.message || error || "portfolio-risk-error")
    }, 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    source: "portfolio-risk",
    version: "portfolio-risk-btc-v2",
    message: "Use POST with positions."
  });
}

function normalizePosition(position) {
  const pair = String(position.pair || "")
    .toUpperCase()
    .replace("/", "")
    .trim();

  if (!pair) return null;

  const riskPercent = Number(position.riskPercent || 0);

  if (!Number.isFinite(riskPercent) || riskPercent <= 0) {
    return null;
  }

  return {
    pair,
    riskPercent,
    groups: getPairRiskGroups(pair)
  };
}

function buildRiskGroups(positions) {
  const map = {};

  for (const position of positions) {
    for (const groupName of position.groups) {
      if (!map[groupName]) {
        map[groupName] = {
          name: groupName,
          riskPercent: 0,
          positions: []
        };
      }

      map[groupName].riskPercent += Number(position.riskPercent || 0);
      map[groupName].positions.push({
        pair: position.pair,
        riskPercent: Number(position.riskPercent || 0)
      });
    }
  }

  return Object.values(map)
    .map((group) => ({
      ...group,
      riskPercent: round(group.riskPercent)
    }))
    .sort((a, b) => Number(b.riskPercent || 0) - Number(a.riskPercent || 0));
}

function getPairRiskGroups(pair) {
  const p = String(pair || "").toUpperCase();
  const groups = [];

  if (p === "BTCUSD") {
    groups.push("BTC_USD");
    groups.push("USD");
    groups.push("CRYPTO");
    return groups;
  }

  if (p === "XAUUSD") {
    groups.push("GOLD_USD");
    groups.push("USD");
    groups.push("METALS");
    return groups;
  }

  if (p.includes("USD")) groups.push("USD");
  if (p.includes("EUR")) groups.push("EUR");
  if (p.includes("GBP")) groups.push("GBP");
  if (p.includes("JPY")) groups.push("JPY");
  if (p.includes("CHF")) groups.push("CHF");
  if (p.includes("CAD")) groups.push("CAD");
  if (p.includes("AUD")) groups.push("AUD");
  if (p.includes("NZD")) groups.push("NZD");

  if (p.includes("AUD") || p.includes("NZD")) {
    groups.push("AUD_NZD");
  }

  return [...new Set(groups)];
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

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Number(n.toFixed(digits));
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
