// ai-decision.fixed.js

export async function onRequestPost(context) {
  return handleAiDecision(context);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

async function handleAiDecision(context) {
  try {
    const body = await safeJson(context.request);
    const payload = normalizePayload(body?.data ?? body ?? {});

    const decision = buildDecision(payload);

    return json({
      ok: true,
      source: "ai-decision-v2",
      ...decision
    });
  } catch (error) {
    return json({
      ok: true,
      source: "ai-decision-fallback",
      decision: "WAIT",
      title: "Décision indisponible",
      reason: "AI decision fallback activé.",
      confidence: 50,
      action: "WAIT",
      window: "intraday",
      error: String(error?.message || error || "unknown")
    });
  }
}

function normalizePayload(input) {
  return {
    pair: cleanPair(input.pair),
    timeframe: normalizeTimeframe(input.timeframe),
    finalScore: safeNum(input.finalScore),
    trendScore: safeNum(input.trendScore),
    timingScore: safeNum(input.timingScore),
    riskScore: safeNum(input.riskScore),
    contextScore: safeNum(input.contextScore),
    mlScore: safeNum(input.mlScore),
    vectorbtScore: safeNum(input.vectorbtScore),
    signal: normalizeSignal(input.signal)
  };
}

function buildDecision(payload) {
  const confidence = Math.round(
    payload.finalScore * 0.45 +
    payload.mlScore * 0.20 +
    payload.vectorbtScore * 0.20 +
    payload.riskScore * 0.05 +
    payload.contextScore * 0.10
  );

  const blockerReasons = [];

  if (payload.mlScore < 45) blockerReasons.push("ML score too low");
  if (payload.vectorbtScore < 45) blockerReasons.push("VectorBT score too low");
  if (payload.riskScore < 40) blockerReasons.push("Risk score too low");
  if (payload.finalScore < 55) blockerReasons.push("Final score too low");

  if (blockerReasons.length) {
    return {
      decision: "NO TRADE",
      title: `${payload.pair || "Asset"} blocked`,
      reason: blockerReasons.join(" • "),
      confidence: clamp(confidence, 1, 99),
      action: "WAIT",
      window: inferWindow(payload.timeframe)
    };
  }

  if (payload.finalScore >= 80 && payload.mlScore >= 70 && payload.vectorbtScore >= 70) {
    return {
      decision: payload.signal === "SELL" ? "TRADE" : "TRADE",
      title: `${payload.pair || "Asset"} premium setup`,
      reason: "High confluence between scoring, ML and VectorBT.",
      confidence: clamp(confidence + 8, 1, 99),
      action: payload.signal === "SELL" ? "EXECUTE SELL" : "EXECUTE BUY",
      window: inferWindow(payload.timeframe)
    };
  }

  if (payload.finalScore >= 68) {
    return {
      decision: "TRADE",
      title: `${payload.pair || "Asset"} valid setup`,
      reason: "Acceptable setup with controlled quality and risk.",
      confidence: clamp(confidence, 1, 99),
      action: payload.signal === "SELL" ? "EXECUTE SELL" : "EXECUTE BUY",
      window: inferWindow(payload.timeframe)
    };
  }

  return {
    decision: "WAIT",
    title: `${payload.pair || "Asset"} needs patience`,
    reason: "Setup quality is not high enough yet.",
    confidence: clamp(confidence - 6, 1, 99),
    action: "WAIT",
    window: inferWindow(payload.timeframe)
  };
}

function inferWindow(timeframe) {
  if (timeframe === "M5") return "scalp";
  if (timeframe === "M15") return "intraday";
  if (timeframe === "H1") return "intra-swing";
  return "swing";
}

function normalizeSignal(value) {
  const v = String(value || "").toUpperCase().trim();
  if (v.includes("SELL")) return "SELL";
  if (v.includes("BUY")) return "BUY";
  return "WAIT";
}

function normalizeTimeframe(value) {
  const tf = String(value || "").toUpperCase().trim();
  if (["M5", "M15", "H1", "H4"].includes(tf)) return tf;
  return "M15";
}

function cleanPair(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function clamp(v, min = 1, max = 99) {
  const n = Number(v || 0);
  return Math.max(min, Math.min(max, n));
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
    }
