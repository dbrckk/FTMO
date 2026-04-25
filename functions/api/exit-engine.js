const MODEL_VERSION = "exit-engine-btc-v3";

export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const scan = normalizeScan(body.scan || body);
    const ai = normalizeAi(body.ai || body.decision || {});

    if (!scan.pair) {
      return json({
        ok: false,
        error: "Missing pair",
        exitAction: "HOLD",
        exitScore: 50,
        comment: "No pair provided."
      }, 400);
    }

    const result = buildExitDecision(scan, ai);

    return json({
      ok: true,
      source: "exit-engine",
      version: MODEL_VERSION,
      pair: scan.pair,
      timeframe: scan.timeframe,
      ...result
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "exit-engine-error"),
      exitAction: "HOLD",
      exitScore: 50,
      comment: "Fallback hold mode."
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
      ultraScore: url.searchParams.get("ultraScore") || 50,
      trendScore: url.searchParams.get("trendScore") || 50,
      timingScore: url.searchParams.get("timingScore") || 50,
      riskScore: url.searchParams.get("riskScore") || 50,
      executionScore: url.searchParams.get("executionScore") || 50,
      smartMoneyScore: url.searchParams.get("smartMoneyScore") || 50,
      archiveEdgeScore: url.searchParams.get("archiveEdgeScore") || 50,
      mtfScore: url.searchParams.get("mtfScore") || 0,
      mtfSignal: url.searchParams.get("mtfSignal") || "",
      rsi14: url.searchParams.get("rsi14") || 50,
      momentum: url.searchParams.get("momentum") || 0,
      volatility: url.searchParams.get("volatility") || 0,
      rr: url.searchParams.get("rr") || 2
    });

    const ai = normalizeAi({
      decision: url.searchParams.get("decision") || "WAIT",
      action: url.searchParams.get("action") || "WAIT"
    });

    const result = buildExitDecision(scan, ai);

    return json({
      ok: true,
      source: "exit-engine",
      version: MODEL_VERSION,
      pair: scan.pair,
      timeframe: scan.timeframe,
      ...result
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "exit-engine-get-error"),
      exitAction: "HOLD",
      exitScore: 50,
      comment: "Fallback hold mode."
    }, 500);
  }
}

function normalizeScan(input) {
  const pair = String(input.pair || "")
    .toUpperCase()
    .replace("/", "")
    .trim();

  return {
    pair,
    timeframe: normalizeTimeframe(input.timeframe) || "M15",
    signal: String(input.signal || "WAIT").toUpperCase(),
    direction: String(input.direction || "").toLowerCase(),

    current: safeNumber(input.current, 0),
    stopLoss: safeNumber(input.stopLoss, 0),
    takeProfit: safeNumber(input.takeProfit, 0),

    ultraScore: safeNumber(input.ultraScore, 50),
    finalScore: safeNumber(input.finalScore, 50),
    mlScore: safeNumber(input.mlScore, 50),
    vectorbtScore: safeNumber(input.vectorbtScore, 50),

    trendScore: safeNumber(input.trendScore, 50),
    timingScore: safeNumber(input.timingScore, 50),
    riskScore: safeNumber(input.riskScore, 50),
    smartMoneyScore: safeNumber(input.smartMoneyScore, 50),
    executionScore: safeNumber(input.executionScore, 50),
    archiveEdgeScore: safeNumber(input.archiveEdgeScore, 50),

    mtfScore: safeNumber(input.mtfScore, 0),
    mtfSignal: String(input.mtfSignal || "").toUpperCase(),

    rsi14: safeNumber(input.rsi14, 50),
    momentum: safeNumber(input.momentum, 0),
    volatility: safeNumber(input.volatility, 0),
    rr: safeNumber(input.rr, getDefaultRr(pair))
  };
}

function normalizeAi(input) {
  return {
    decision: String(input.decision || "WAIT").toUpperCase(),
    action: String(input.action || "WAIT").toUpperCase(),
    confidence: safeNumber(input.confidence, 50),
    riskMode: String(input.riskMode || "normal")
  };
}

function buildExitDecision(scan, ai) {
  const profile = getPairProfile(scan.pair);
  const exitPressure = computeExitPressure(scan, ai, profile);
  const protection = computeProtectionMode(scan, profile);
  const exitAction = getExitAction(exitPressure, scan, ai, profile);
  const comment = buildComment(exitAction, exitPressure, scan, ai, profile);

  return {
    exitAction,
    exitScore: Math.round(exitPressure),
    protection,
    comment,
    shouldClose: exitAction === "CLOSE",
    shouldReduce: exitAction === "REDUCE",
    shouldTrail: exitAction === "TRAIL",
    components: {
      trendScore: Math.round(scan.trendScore),
      timingScore: Math.round(scan.timingScore),
      riskScore: Math.round(scan.riskScore),
      executionScore: Math.round(scan.executionScore),
      smartMoneyScore: Math.round(scan.smartMoneyScore),
      archiveEdgeScore: Math.round(scan.archiveEdgeScore),
      mtfScore: Math.round(scan.mtfScore || 0),
      rsi14: round(scan.rsi14, 2),
      momentum: round(scan.momentum, 3),
      volatility: round(scan.volatility, 5)
    },
    notes: buildNotes(exitAction, scan, profile)
  };
}

function computeExitPressure(scan, ai, profile) {
  let pressure = 35;

  pressure += scoreWeakness(scan.trendScore, profile.trendWeakLevel) * 0.20;
  pressure += scoreWeakness(scan.timingScore, profile.timingWeakLevel) * 0.18;
  pressure += scoreWeakness(scan.executionScore, profile.executionWeakLevel) * 0.16;
  pressure += scoreWeakness(scan.smartMoneyScore, profile.smartWeakLevel) * 0.12;
  pressure += scoreWeakness(scan.riskScore, profile.riskWeakLevel) * 0.12;
  pressure += scoreWeakness(scan.archiveEdgeScore, 45) * 0.08;

  if (scan.signal === "WAIT") pressure += 10;

  if (
    ai.decision &&
    ai.decision !== "WAIT" &&
    scan.signal !== "WAIT" &&
    ai.decision !== scan.signal
  ) {
    pressure += 14;
  }

  if (
    scan.mtfSignal &&
    scan.mtfSignal !== "WAIT" &&
    scan.signal !== "WAIT" &&
    scan.mtfSignal !== scan.signal
  ) {
    pressure += 18;
  }

  if (scan.mtfScore > 0 && scan.mtfScore < profile.minMtfHoldScore) {
    pressure += 10;
  }

  if (profile.type === "crypto") {
    if (scan.volatility > 0.04) pressure += 16;
    if (Math.abs(scan.momentum) > 7) pressure += 9;
    if (scan.riskScore < 44) pressure += 8;
  }

  if (profile.type === "gold") {
    if (scan.volatility > 0.025) pressure += 12;
    if (Math.abs(scan.momentum) > 3.2) pressure += 7;
  }

  if (scan.ultraScore >= 82 && scan.riskScore >= 50) {
    pressure -= 8;
  }

  if (scan.archiveEdgeScore >= 62) {
    pressure -= 5;
  }

  return clamp(pressure, 1, 99);
}

function scoreWeakness(score, weakLevel) {
  const n = Number(score || 50);

  if (n >= weakLevel + 18) return 0;
  if (n >= weakLevel + 10) return 12;
  if (n >= weakLevel) return 28;
  if (n >= weakLevel - 10) return 48;

  return 70;
}

function computeProtectionMode(scan, profile) {
  if (scan.pair === "BTCUSD") {
    if (scan.volatility > 0.035) return "BTC tight protection";
    if (scan.ultraScore >= 82) return "BTC trail allowed";
    return "BTC reduced hold";
  }

  if (scan.pair === "XAUUSD") {
    if (scan.volatility > 0.02) return "Gold tight protection";
    if (scan.ultraScore >= 82) return "Gold trail allowed";
    return "Gold normal hold";
  }

  if (scan.ultraScore >= 82) return "Trail allowed";
  if (scan.riskScore < 45) return "Tight protection";

  return profile.type === "forex" ? "Normal hold" : "Reduced hold";
}

function getExitAction(exitPressure, scan, ai, profile) {
  if (exitPressure >= profile.closeLevel) return "CLOSE";
  if (exitPressure >= profile.reduceLevel) return "REDUCE";

  if (
    exitPressure >= profile.trailLevel ||
    (scan.ultraScore >= 82 && scan.executionScore >= 62)
  ) {
    return "TRAIL";
  }

  return "HOLD";
}

function buildComment(exitAction, exitPressure, scan, ai, profile) {
  const parts = [];

  if (scan.pair === "BTCUSD") {
    parts.push("BTC exit engine active.");
  } else if (scan.pair === "XAUUSD") {
    parts.push("Gold exit engine active.");
  } else {
    parts.push("Forex exit engine active.");
  }

  parts.push(`Exit pressure ${Math.round(exitPressure)}/100.`);

  if (exitAction === "CLOSE") {
    parts.push("Close signal because exit pressure is high.");
  } else if (exitAction === "REDUCE") {
    parts.push("Reduce exposure because conditions weakened.");
  } else if (exitAction === "TRAIL") {
    parts.push("Hold with trailing protection.");
  } else {
    parts.push("Hold position. No exit signal.");
  }

  if (scan.mtfSignal && scan.mtfSignal !== "WAIT") {
    parts.push(`MTF ${scan.mtfSignal} ${Math.round(scan.mtfScore || 0)}/100.`);
  }

  if (profile.type === "crypto" && scan.volatility > 0.035) {
    parts.push("BTC volatility is elevated.");
  }

  if (ai.decision && ai.decision !== "WAIT") {
    parts.push(`AI decision ${ai.decision}.`);
  }

  return parts.join(" ");
}

function buildNotes(exitAction, scan, profile) {
  const notes = [];

  notes.push(`Exit action ${exitAction}`);

  if (profile.type === "crypto") {
    notes.push("BTC uses stricter volatility exits.");
  }

  if (profile.type === "gold") {
    notes.push("Gold uses volatility-adjusted exits.");
  }

  if (scan.signal === "WAIT") {
    notes.push("Scanner returned WAIT.");
  }

  if (scan.mtfScore > 0 && scan.mtfScore < profile.minMtfHoldScore) {
    notes.push("MTF hold score weak.");
  }

  return notes;
}

function getPairProfile(pair) {
  if (pair === "BTCUSD") {
    return {
      type: "crypto",
      trendWeakLevel: 52,
      timingWeakLevel: 50,
      executionWeakLevel: 48,
      smartWeakLevel: 48,
      riskWeakLevel: 46,
      minMtfHoldScore: 60,
      trailLevel: 54,
      reduceLevel: 68,
      closeLevel: 82
    };
  }

  if (pair === "XAUUSD") {
    return {
      type: "gold",
      trendWeakLevel: 50,
      timingWeakLevel: 48,
      executionWeakLevel: 46,
      smartWeakLevel: 46,
      riskWeakLevel: 44,
      minMtfHoldScore: 58,
      trailLevel: 56,
      reduceLevel: 70,
      closeLevel: 84
    };
  }

  return {
    type: "forex",
    trendWeakLevel: 48,
    timingWeakLevel: 46,
    executionWeakLevel: 45,
    smartWeakLevel: 45,
    riskWeakLevel: 42,
    minMtfHoldScore: 56,
    trailLevel: 58,
    reduceLevel: 72,
    closeLevel: 86
  };
}

function getDefaultRr(pair) {
  if (pair === "BTCUSD") return 2.1;
  if (pair === "XAUUSD") return 2.2;

  return 2;
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
