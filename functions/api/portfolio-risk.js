export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const positions = Array.isArray(body.positions) ? body.positions : [];

    const result = computePortfolioRisk(positions);

    return json({
      ok: true,
      source: "local-portfolio-risk-engine",
      ...result
    });
  } catch (error) {
    return json({
      ok: false,
      decision: "REDUCE",
      totalRiskPercent: 0,
      maxPairRiskPercent: 0,
      reason: String(error?.message || "Portfolio risk fallback.")
    });
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    message: "POST positions to compute FTMO portfolio risk."
  });
}

function computePortfolioRisk(positions) {
  const normalized = positions
    .map((position) => ({
      pair: String(position.pair || "").toUpperCase(),
      riskPercent: Number(position.riskPercent || 0)
    }))
    .filter((position) => position.pair && Number.isFinite(position.riskPercent));

  const totalRiskPercent = normalized.reduce(
    (sum, position) => sum + position.riskPercent,
    0
  );

  const pairRiskMap = {};

  for (const position of normalized) {
    pairRiskMap[position.pair] = (pairRiskMap[position.pair] || 0) + position.riskPercent;
  }

  const maxPairRiskPercent = Math.max(0, ...Object.values(pairRiskMap));
  const correlatedGroups = buildCorrelatedGroups(normalized);
  const maxGroupRiskPercent = Math.max(0, ...correlatedGroups.map((g) => g.riskPercent));

  if (totalRiskPercent >= 4.5) {
    return {
      decision: "BLOCK",
      totalRiskPercent: round(totalRiskPercent),
      maxPairRiskPercent: round(maxPairRiskPercent),
      maxGroupRiskPercent: round(maxGroupRiskPercent),
      correlatedGroups,
      reason: "Risque total trop proche de la limite journalière FTMO."
    };
  }

  if (maxPairRiskPercent >= 2) {
    return {
      decision: "REDUCE",
      totalRiskPercent: round(totalRiskPercent),
      maxPairRiskPercent: round(maxPairRiskPercent),
      maxGroupRiskPercent: round(maxGroupRiskPercent),
      correlatedGroups,
      reason: "Risque concentré sur une seule paire."
    };
  }

  if (maxGroupRiskPercent >= 2.5) {
    return {
      decision: "REDUCE",
      totalRiskPercent: round(totalRiskPercent),
      maxPairRiskPercent: round(maxPairRiskPercent),
      maxGroupRiskPercent: round(maxGroupRiskPercent),
      correlatedGroups,
      reason: "Risque trop concentré sur un groupe corrélé."
    };
  }

  if (totalRiskPercent >= 3) {
    return {
      decision: "CAUTION",
      totalRiskPercent: round(totalRiskPercent),
      maxPairRiskPercent: round(maxPairRiskPercent),
      maxGroupRiskPercent: round(maxGroupRiskPercent),
      correlatedGroups,
      reason: "Risque global élevé, éviter d’ajouter trop d’exposition."
    };
  }

  return {
    decision: "ALLOW",
    totalRiskPercent: round(totalRiskPercent),
    maxPairRiskPercent: round(maxPairRiskPercent),
    maxGroupRiskPercent: round(maxGroupRiskPercent),
    correlatedGroups,
    reason: "Risque portefeuille acceptable."
  };
}

function buildCorrelatedGroups(positions) {
  const groups = [
    {
      name: "USD majors",
      pairs: ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDCHF", "USDCAD", "USDJPY"]
    },
    {
      name: "EUR crosses",
      pairs: ["EURUSD", "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD"]
    },
    {
      name: "GBP crosses",
      pairs: ["GBPUSD", "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD", "EURGBP"]
    },
    {
      name: "JPY crosses",
      pairs: ["USDJPY", "EURJPY", "GBPJPY", "AUDJPY", "NZDJPY"]
    },
    {
      name: "AUD/NZD",
      pairs: ["AUDUSD", "NZDUSD", "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD", "NZDJPY", "NZDCAD"]
    },
    {
      name: "Gold / USD risk",
      pairs: ["XAUUSD", "EURUSD", "GBPUSD", "AUDUSD", "NZDUSD"]
    }
  ];

  return groups
    .map((group) => {
      const groupPositions = positions.filter((position) =>
        group.pairs.includes(position.pair)
      );

      const riskPercent = groupPositions.reduce(
        (sum, position) => sum + position.riskPercent,
        0
      );

      return {
        name: group.name,
        pairs: groupPositions.map((position) => position.pair),
        riskPercent: round(riskPercent)
      };
    })
    .filter((group) => group.riskPercent > 0)
    .sort((a, b) => b.riskPercent - a.riskPercent);
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function round(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
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
