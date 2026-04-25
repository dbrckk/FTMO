const MODEL_VERSION = "ai-decision-btc-v3";

export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const scan = normalizeScan(body.scan || body);

    if (!scan.pair) {
      return json({
        ok: false,
        error: "Missing pair",
        decision: "WAIT",
        action: "WAIT",
        title: "No pair provided",
        reason: "The AI decision engine needs a valid pair."
      }, 400);
    }

    const decision = buildDecision(scan);

    return json({
      ok: true,
      source: "ai-decision",
      version: MODEL_VERSION,
      ...decision
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "ai-decision-error"),
      decision: "WAIT",
      action: "WAIT",
      title: "AI decision unavailable",
      reason: "Fallback safety mode."
    }, 500);
  }
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);

    const scan = normalizeScan({
      pair: url.searchParams.get("pair") || "EURUSD",
      timeframe: url.searchParams.get("timeframe") || "M15",
      signal: url.searchParams.get("signal") || "WAIT",
      tradeAllowed: url.searchParams.get("tradeAllowed") || false,
      ultraScore: url.searchParams.get("ultraScore") || 50,
      finalScore: url.searchParams.get("finalScore") || 50,
      mlScore: url.searchParams.get("mlScore") || 50,
      vectorbtScore: url.searchParams.get("vectorbtScore") || 50,
      trendScore: url.searchParams.get("trendScore") || 50,
      timingScore: url.searchParams.get("timingScore") || 50,
      riskScore: url.searchParams.get("riskScore") || 50,
      smartMoneyScore: url.searchParams.get("smartMoneyScore") || 50,
      executionScore: url.searchParams.get("executionScore") || 50,
      archiveEdgeScore: url.searchParams.get("archiveEdgeScore") || 50,
      mtfScore: url.searchParams.get("mtfScore") || 0,
      mtfSignal: url.searchParams.get("mtfSignal") || "",
      rr: url.searchParams.get("rr") || 2
    });

    const decision = buildDecision(scan);

    return json({
      ok: true,
      source: "ai-decision",
      version: MODEL_VERSION,
      ...decision
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "ai-decision-get-error"),
      decision: "WAIT",
      action: "WAIT",
      title: "AI decision unavailable",
      reason: "Fallback safety mode."
    }, 500);
  }
}

function normalizeScan(input) {
  const pair = String(input.pair || "")
    .toUpperCase()
    .replace("/", "")
    .trim();

  const signal = String(input.signal || "WAIT").toUpperCase();
  const direction = String(input.direction || "").toLowerCase();

  return {
    pair,
    timeframe: normalizeTimeframe(input.timeframe) || "M15",
    signal,
    direction,

    tradeAllowed:
      input.tradeAllowed === true ||
      input.tradeAllowed === "true" ||
      input.allowed === true ||
      input.allowed === "true",

    tradeStatus: String(input.tradeStatus || input.status || "WAIT"),
    tradeReason: String(input.tradeReason || input.reason || ""),

    current: safeNumber(input.current, 0),
    stopLoss: safeNumber(input.stopLoss, 0),
    takeProfit: safeNumber(input.takeProfit, 0),

    ultraScore: safeNumber(input.ultraScore, 50),
    finalScore: safeNumber(input.finalScore, 50),
    localScore: safeNumber(input.localScore, 50),

    mlScore: safeNumber(input.mlScore, 50),
    vectorbtScore: safeNumber(input.vectorbtScore, 50),

    trendScore: safeNumber(input.trendScore, 50),
    timingScore: safeNumber(input.timingScore, 50),
    riskScore: safeNumber(input.riskScore, 50),
    smartMoneyScore: safeNumber(input.smartMoneyScore, 50),
    sessionScore: safeNumber(input.sessionScore, 50),
    executionScore: safeNumber(input.executionScore, 50),
    archiveEdgeScore: safeNumber(input.archiveEdgeScore, 50),

    mtfScore: safeNumber(input.mtfScore, 0),
    mtfSignal: String(input.mtfSignal || "").toUpperCase(),
    mtfLabel: String(input.mtfLabel || ""),

    rsi14: safeNumber(input.rsi14, 50),
    momentum: safeNumber(input.momentum, 0),
    volatility: safeNumber(input.volatility, 0),
    rr: safeNumber(input.rr, getDefaultRr(pair))
  };
}

function buildDecision(scan) {
  const profile = getPairProfile(scan.pair);
  const score = computeDecisionScore(scan, profile);
  const confidence = Math.round(score);

  const blockers = getBlockers(scan, profile, score);
  const hasDirectionalSignal = scan.signal === "BUY" || scan.signal === "SELL";
  const decision = blockers.length || !hasDirectionalSignal ? "WAIT" : scan.signal;

  const action =
    decision === "BUY" || decision === "SELL"
      ? "EXECUTE"
      : "WAIT";

  const title = buildTitle(scan, decision, score, blockers);
  const reason = buildReason(scan, decision, score, blockers, profile);
  const riskMode = buildRiskMode(scan, profile, score);
  const window = getTradingWindow(scan.timeframe, scan.pair);
  const badge = buildBadge(decision, score, profile);

  return {
    pair: scan.pair,
    timeframe: scan.timeframe,
    decision,
    action,
    title,
    reason,
    confidence,
    window,
    badge,
    riskMode,
    modelBias: getModelBias(decision, score),
    components: {
      decisionScore: Math.round(score),
      ultraScore: Math.round(scan.ultraScore),
      mlScore: Math.round(scan.mlScore),
      vectorbtScore: Math.round(scan.vectorbtScore),
      trendScore: Math.round(scan.trendScore),
      timingScore: Math.round(scan.timingScore),
      riskScore: Math.round(scan.riskScore),
      archiveEdgeScore: Math.round(scan.archiveEdgeScore),
      mtfScore: scan.mtfScore ? Math.round(scan.mtfScore) : 0,
      rr: round(scan.rr, 2)
    },
    blockers,
    notes: buildNotes(scan, decision, score, profile, blockers)
  };
}

function computeDecisionScore(scan, profile) {
  let score = clamp(
    safeNumber(scan.ultraScore, 50) * 0.26 +
      safeNumber(scan.mlScore, 50) * 0.18 +
      safeNumber(scan.vectorbtScore, 50) * 0.16 +
      safeNumber(scan.trendScore, 50) * 0.12 +
      safeNumber(scan.timingScore, 50) * 0.10 +
      safeNumber(scan.riskScore, 50) * 0.08 +
      safeNumber(scan.archiveEdgeScore, 50) * 0.07 +
      safeNumber(scan.executionScore, 50) * 0.03,
    1,
    99
  );

  if (scan.mtfScore > 0) {
    score = clamp(score * 0.86 + scan.mtfScore * 0.14, 1, 99);
  }

  if (scan.signal === "WAIT") {
    score -= 16;
  }

  if (profile.type === "crypto") {
    score -= 3;

    if (scan.timeframe === "H1" || scan.timeframe === "H4") score += 3;
    if (scan.riskScore < 45) score -= 8;
    if (scan.volatility > 0.035) score -= 10;
    if (scan.mtfScore >= 78) score += 4;
  }

  if (profile.type === "gold") {
    if (scan.timeframe === "H1" || scan.timeframe === "H4") score += 2;
    if (scan.riskScore < 45) score -= 5;
  }

  return clamp(score, 1, 99);
}

function getBlockers(scan, profile, score) {
  const blockers = [];

  if (scan.signal !== "BUY" && scan.signal !== "SELL") {
    blockers.push("No directional signal.");
  }

  if (!scan.tradeAllowed && score < profile.strongOverrideScore) {
    blockers.push(scan.tradeReason || "Scanner did not allow this setup.");
  }

  if (score < profile.minDecisionScore) {
    blockers.push(`Decision score too weak: ${Math.round(score)}/100.`);
  }

  if (scan.riskScore < profile.minRiskScore) {
    blockers.push(`Risk score too weak: ${Math.round(scan.riskScore)}/100.`);
  }

  if (scan.mtfScore > 0 && scan.mtfScore < profile.minMtfScore) {
    blockers.push(`MTF score too weak: ${Math.round(scan.mtfScore)}/100.`);
  }

  if (
    scan.mtfSignal &&
    scan.signal !== "WAIT" &&
    scan.mtfSignal !== "WAIT" &&
    scan.mtfSignal !== scan.signal
  ) {
    blockers.push(`MTF opposite direction: ${scan.mtfSignal}.`);
  }

  if (scan.rr < profile.minRr) {
    blockers.push(`RR too low: ${round(scan.rr, 2)}.`);
  }

  if (profile.type === "crypto" && scan.volatility > 0.045) {
    blockers.push("BTC volatility too extreme.");
  }

  return [...new Set(blockers)].filter(Boolean);
}

function buildTitle(scan, decision, score, blockers) {
  const pairLabel = getPairLabel(scan.pair);

  if (blockers.length || decision === "WAIT") {
    if (scan.pair === "BTCUSD") {
      return `BTC setup blocked · ${Math.round(score)}/100`;
    }

    if (scan.pair === "XAUUSD") {
      return `Gold setup blocked · ${Math.round(score)}/100`;
    }

    return `${pairLabel} waiting confirmation · ${Math.round(score)}/100`;
  }

  if (scan.pair === "BTCUSD") {
    return `BTC ${decision} candidate · ${Math.round(score)}/100`;
  }

  if (scan.pair === "XAUUSD") {
    return `Gold ${decision} candidate · ${Math.round(score)}/100`;
  }

  return `${pairLabel} ${decision} candidate · ${Math.round(score)}/100`;
}

function buildReason(scan, decision, score, blockers, profile) {
  if (blockers.length || decision === "WAIT") {
    return [
      profile.type === "crypto"
        ? "BTC filter active."
        : profile.type === "gold"
          ? "Gold filter active."
          : "Forex filter active.",
      blockers.slice(0, 3).join(" "),
      `Ultra ${Math.round(scan.ultraScore)}, ML ${Math.round(scan.mlScore)}, VBT ${Math.round(scan.vectorbtScore)}.`
    ].filter(Boolean).join(" ");
  }

  const parts = [];

  if (profile.type === "crypto") {
    parts.push("BTC decision uses stricter volatility and reduced risk.");
  } else if (profile.type === "gold") {
    parts.push("Gold decision uses volatility-adjusted risk.");
  } else {
    parts.push("Setup accepted by AI confluence.");
  }

  parts.push(`Signal ${decision}.`);
  parts.push(`Score ${Math.round(score)}/100.`);
  parts.push(`Trend ${Math.round(scan.trendScore)}, timing ${Math.round(scan.timingScore)}, risk ${Math.round(scan.riskScore)}.`);

  if (scan.mtfScore > 0) {
    parts.push(`MTF ${Math.round(scan.mtfScore)}/100${scan.mtfSignal ? ` ${scan.mtfSignal}` : ""}.`);
  }

  return parts.join(" ");
}

function buildRiskMode(scan, profile, score) {
  if (score >= 88 && scan.riskScore >= 60) {
    return profile.type === "crypto" ? "reduced-aggressive" : "aggressive";
  }

  if (score >= 76 && scan.riskScore >= 50) {
    return profile.type === "crypto" ? "reduced-normal" : "normal";
  }

  if (score >= 66) {
    return "small-risk";
  }

  return "no-risk";
}

function buildBadge(decision, score, profile) {
  if (decision === "WAIT") return "WAIT";
  if (profile.type === "crypto") return score >= 82 ? "BTC HIGH EDGE" : "BTC VALID";
  if (profile.type === "gold") return score >= 82 ? "GOLD HIGH EDGE" : "GOLD VALID";
  return score >= 82 ? "HIGH EDGE" : "VALID";
}

function buildNotes(scan, decision, score, profile, blockers) {
  const notes = [];

  notes.push(`Decision score ${Math.round(score)}/100`);
  notes.push(`Signal ${decision}`);

  if (profile.type === "crypto") {
    notes.push("BTCUSD uses lower risk and wider stop logic.");
  }

  if (profile.type === "gold") {
    notes.push("XAUUSD uses gold-specific volatility logic.");
  }

  if (scan.mtfScore > 0) {
    notes.push(`MTF ${Math.round(scan.mtfScore)}/100 ${scan.mtfSignal || ""}`.trim());
  }

  if (blockers.length) {
    notes.push(`Blocked: ${blockers[0]}`);
  }

  return notes;
}

function getPairProfile(pair) {
  if (pair === "BTCUSD") {
    return {
      type: "crypto",
      minDecisionScore: 74,
      strongOverrideScore: 86,
      minRiskScore: 44,
      minMtfScore: 60,
      minRr: 1.8
    };
  }

  if (pair === "XAUUSD") {
    return {
      type: "gold",
      minDecisionScore: 72,
      strongOverrideScore: 84,
      minRiskScore: 43,
      minMtfScore: 58,
      minRr: 1.8
    };
  }

  return {
    type: "forex",
    minDecisionScore: 70,
    strongOverrideScore: 82,
    minRiskScore: 42,
    minMtfScore: 56,
    minRr: 1.7
  };
}

function getDefaultRr(pair) {
  if (pair === "BTCUSD") return 2.1;
  if (pair === "XAUUSD") return 2.2;

  return 2;
}

function getTradingWindow(timeframe, pair) {
  const p = String(pair || "").toUpperCase();

  if (p === "BTCUSD") {
    if (timeframe === "M5") return "BTC scalp";
    if (timeframe === "M15") return "BTC intraday";
    if (timeframe === "H1") return "BTC swing";
    if (timeframe === "H4") return "BTC position";
  }

  if (timeframe === "M5") return "Scalp";
  if (timeframe === "M15") return "Intraday";
  if (timeframe === "H1") return "Swing";
  if (timeframe === "H4") return "Position";

  return "Intraday";
}

function getModelBias(decision, score) {
  if (decision === "BUY" && score >= 72) return "bullish";
  if (decision === "SELL" && score >= 72) return "bearish";
  if (score < 58) return "avoid";

  return "neutral";
}

function getPairLabel(pair) {
  if (pair === "BTCUSD") return "BTCUSD";
  if (pair === "XAUUSD") return "XAUUSD";

  return pair || "Pair";
}

function normalizeTimeframe(value) {
  const timeframe = String(value || "")
    .toUpperCase()
    .trim();

  return ["M5", "M15", "H1", "H4"].includes(timeframe) ? timeframe : "";
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

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
      }
