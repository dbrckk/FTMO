const MODEL_VERSION = "ml-score-btc-v3";

export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const scan = normalizeScan(body.scan || body);

    if (!scan.pair) {
      return json({
        ok: false,
        error: "Missing pair"
      }, 400);
    }

    const result = scoreMl(scan);

    return json({
      ok: true,
      source: "ml-score",
      version: MODEL_VERSION,
      pair: scan.pair,
      timeframe: scan.timeframe,
      ...result
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "ml-score-error"),
      mlScore: 50,
      confidenceBand: "fallback"
    }, 500);
  }
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);

    const scan = normalizeScan({
      pair: url.searchParams.get("pair") || "EURUSD",
      timeframe: url.searchParams.get("timeframe") || "M15",
      ultraScore: url.searchParams.get("ultraScore") || 50,
      trendScore: url.searchParams.get("trendScore") || 50,
      timingScore: url.searchParams.get("timingScore") || 50,
      riskScore: url.searchParams.get("riskScore") || 50,
      smartMoneyScore: url.searchParams.get("smartMoneyScore") || 50,
      executionScore: url.searchParams.get("executionScore") || 50,
      archiveEdgeScore: url.searchParams.get("archiveEdgeScore") || 50,
      rsi14: url.searchParams.get("rsi14") || 50,
      momentum: url.searchParams.get("momentum") || 0,
      volatility: url.searchParams.get("volatility") || 0,
      signal: url.searchParams.get("signal") || "WAIT"
    });

    const result = scoreMl(scan);

    return json({
      ok: true,
      source: "ml-score",
      version: MODEL_VERSION,
      pair: scan.pair,
      timeframe: scan.timeframe,
      ...result
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "ml-score-get-error"),
      mlScore: 50,
      confidenceBand: "fallback"
    }, 500);
  }
}

function normalizeScan(input) {
  const pair = String(input.pair || "")
    .toUpperCase()
    .replace("/", "")
    .trim();

  const timeframe = normalizeTimeframe(input.timeframe) || "M15";
  const signal = String(input.signal || "WAIT").toUpperCase();

  return {
    pair,
    timeframe,
    signal,
    direction: String(input.direction || "").toLowerCase(),

    ultraScore: safeNumber(input.ultraScore, 50),
    finalScore: safeNumber(input.finalScore, 50),
    localScore: safeNumber(input.localScore, 50),

    trendScore: safeNumber(input.trendScore, 50),
    timingScore: safeNumber(input.timingScore, 50),
    riskScore: safeNumber(input.riskScore, 50),
    contextScore: safeNumber(input.contextScore, 50),
    smartMoneyScore: safeNumber(input.smartMoneyScore, 50),
    sessionScore: safeNumber(input.sessionScore, 50),
    executionScore: safeNumber(input.executionScore, 50),
    entryTriggerScore: safeNumber(input.entryTriggerScore, 50),
    archiveEdgeScore: safeNumber(input.archiveEdgeScore, 50),
    archiveConfidence: safeNumber(input.archiveConfidence, 0),

    rsi14: safeNumber(input.rsi14, 50),
    atr14: safeNumber(input.atr14, 0),
    momentum: safeNumber(input.momentum, 0),
    volatility: safeNumber(input.volatility, 0),
    rr: safeNumber(input.rr, 2)
  };
}

function scoreMl(scan) {
  const profile = getPairProfile(scan.pair);
  const timeframeBoost = getTimeframeBoost(scan.timeframe);
  const directionScore = scoreDirectionQuality(scan);
  const volatilityScore = scoreVolatility(scan, profile);
  const momentumScore = scoreMomentum(scan, profile);
  const rsiScore = scoreRsi(scan);
  const confluenceScore = scoreConfluence(scan);
  const archiveScore = scoreArchive(scan);
  const executionScore = safeNumber(scan.executionScore, 50);
  const rrScore = clamp(scan.rr * 24, 1, 99);

  let mlScore = clamp(
    confluenceScore * 0.25 +
      directionScore * 0.16 +
      momentumScore * 0.13 +
      volatilityScore * 0.12 +
      rsiScore * 0.10 +
      archiveScore * 0.11 +
      executionScore * 0.08 +
      rrScore * 0.05 +
      timeframeBoost,
    1,
    99
  );

  if (scan.signal === "WAIT") {
    mlScore = clamp(mlScore - 14, 1, 99);
  }

  if (scan.pair === "BTCUSD") {
    mlScore = applyBtcAdjustment(scan, mlScore);
  }

  if (scan.pair === "XAUUSD") {
    mlScore = applyGoldAdjustment(scan, mlScore);
  }

  const confidenceBand = getConfidenceBand(mlScore, scan);
  const modelBias = getModelBias(scan, mlScore);
  const probability = clamp(mlScore / 100, 0.01, 0.99);

  return {
    mlScore: Math.round(mlScore),
    confidenceBand,
    modelBias,
    probability: Number(probability.toFixed(3)),
    components: {
      confluenceScore: Math.round(confluenceScore),
      directionScore: Math.round(directionScore),
      momentumScore: Math.round(momentumScore),
      volatilityScore: Math.round(volatilityScore),
      rsiScore: Math.round(rsiScore),
      archiveScore: Math.round(archiveScore),
      executionScore: Math.round(executionScore),
      rrScore: Math.round(rrScore)
    },
    notes: buildNotes(scan, mlScore, confidenceBand)
  };
}

function getPairProfile(pair) {
  if (pair === "BTCUSD") {
    return {
      type: "crypto",
      volatilityIdealMin: 0.0015,
      volatilityIdealMax: 0.018,
      volatilityDanger: 0.04,
      momentumSweetSpot: 0.45,
      riskPenalty: 8
    };
  }

  if (pair === "XAUUSD") {
    return {
      type: "gold",
      volatilityIdealMin: 0.0008,
      volatilityIdealMax: 0.009,
      volatilityDanger: 0.02,
      momentumSweetSpot: 0.22,
      riskPenalty: 5
    };
  }

  if (pair.includes("JPY")) {
    return {
      type: "yen",
      volatilityIdealMin: 0.0003,
      volatilityIdealMax: 0.006,
      volatilityDanger: 0.015,
      momentumSweetSpot: 0.16,
      riskPenalty: 2
    };
  }

  return {
    type: "forex",
    volatilityIdealMin: 0.00025,
    volatilityIdealMax: 0.005,
    volatilityDanger: 0.013,
    momentumSweetSpot: 0.12,
    riskPenalty: 0
  };
}

function getTimeframeBoost(timeframe) {
  if (timeframe === "H4") return 5;
  if (timeframe === "H1") return 3;
  if (timeframe === "M15") return 0;
  if (timeframe === "M5") return -4;

  return 0;
}

function scoreDirectionQuality(scan) {
  const signal = scan.signal;
  const trend = safeNumber(scan.trendScore, 50);
  const timing = safeNumber(scan.timingScore, 50);
  const smart = safeNumber(scan.smartMoneyScore, 50);

  let score = 50;

  score += (trend - 50) * 0.55;
  score += (timing - 50) * 0.30;
  score += (smart - 50) * 0.20;

  if (signal === "BUY" || signal === "SELL") score += 5;
  if (signal === "WAIT") score -= 12;

  return clamp(score, 1, 99);
}

function scoreMomentum(scan, profile) {
  const momentum = safeNumber(scan.momentum, 0);
  const absMomentum = Math.abs(momentum);
  const signal = scan.signal;

  let score = 50;

  if (signal === "BUY" && momentum > 0) score += 18;
  if (signal === "SELL" && momentum < 0) score += 18;
  if (signal === "BUY" && momentum < 0) score -= 18;
  if (signal === "SELL" && momentum > 0) score -= 18;

  const sweet = profile.momentumSweetSpot;

  if (absMomentum >= sweet) score += 8;
  if (absMomentum >= sweet * 2) score += 5;
  if (absMomentum >= sweet * 5) score -= 10;

  if (profile.type === "crypto") {
    if (absMomentum >= 0.6 && absMomentum <= 4.5) score += 6;
    if (absMomentum > 7) score -= 12;
  }

  return clamp(score, 1, 99);
}

function scoreVolatility(scan, profile) {
  const volatility = safeNumber(scan.volatility, 0);

  if (!volatility) {
    return profile.type === "crypto" ? 48 : 52;
  }

  let score = 50;

  if (volatility >= profile.volatilityIdealMin && volatility <= profile.volatilityIdealMax) {
    score += 22;
  }

  if (volatility < profile.volatilityIdealMin) {
    score -= 8;
  }

  if (volatility > profile.volatilityIdealMax) {
    score -= Math.min(24, (volatility - profile.volatilityIdealMax) * 1200);
  }

  if (volatility > profile.volatilityDanger) {
    score -= profile.type === "crypto" ? 18 : 24;
  }

  if (profile.type === "crypto" && volatility >= 0.002 && volatility <= 0.025) {
    score += 8;
  }

  return clamp(score, 1, 99);
}

function scoreRsi(scan) {
  const rsi = safeNumber(scan.rsi14, 50);
  const signal = scan.signal;

  let score = 50;

  if (rsi >= 43 && rsi <= 66) score += 14;
  if (rsi < 30 || rsi > 75) score -= 16;

  if (signal === "BUY") {
    if (rsi >= 45 && rsi <= 68) score += 8;
    if (rsi > 72) score -= 10;
  }

  if (signal === "SELL") {
    if (rsi >= 32 && rsi <= 55) score += 8;
    if (rsi < 25) score -= 10;
  }

  return clamp(score, 1, 99);
}

function scoreConfluence(scan) {
  const trend = safeNumber(scan.trendScore, 50);
  const timing = safeNumber(scan.timingScore, 50);
  const risk = safeNumber(scan.riskScore, 50);
  const smart = safeNumber(scan.smartMoneyScore, 50);
  const execution = safeNumber(scan.executionScore, 50);
  const context = safeNumber(scan.contextScore, 50);

  return clamp(
    trend * 0.25 +
      timing * 0.22 +
      risk * 0.14 +
      smart * 0.15 +
      execution * 0.14 +
      context * 0.10,
    1,
    99
  );
}

function scoreArchive(scan) {
  const archive = safeNumber(scan.archiveEdgeScore, 50);
  const confidence = safeNumber(scan.archiveConfidence, 0);

  const factor =
    confidence >= 40 ? 1 :
    confidence >= 20 ? 0.82 :
    confidence >= 8 ? 0.62 :
    0.42;

  return clamp(50 + (archive - 50) * factor, 1, 99);
}

function applyBtcAdjustment(scan, score) {
  let out = score;

  const risk = safeNumber(scan.riskScore, 50);
  const volatility = safeNumber(scan.volatility, 0);
  const momentum = Math.abs(safeNumber(scan.momentum, 0));

  out -= 3;

  if (risk < 45) out -= 8;
  if (volatility > 0.035) out -= 12;
  if (volatility >= 0.003 && volatility <= 0.02) out += 5;
  if (momentum >= 0.7 && momentum <= 4.5) out += 4;
  if (momentum > 7) out -= 8;

  if (scan.timeframe === "H1" || scan.timeframe === "H4") {
    out += 3;
  }

  return clamp(out, 1, 99);
}

function applyGoldAdjustment(scan, score) {
  let out = score;

  const volatility = safeNumber(scan.volatility, 0);
  const momentum = Math.abs(safeNumber(scan.momentum, 0));

  if (volatility >= 0.001 && volatility <= 0.012) out += 3;
  if (momentum > 2.5) out -= 5;
  if (scan.timeframe === "H1" || scan.timeframe === "H4") out += 2;

  return clamp(out, 1, 99);
}

function getConfidenceBand(score, scan) {
  const archiveConfidence = safeNumber(scan.archiveConfidence, 0);

  if (score >= 84 && archiveConfidence >= 20) return "very-high";
  if (score >= 76) return "high";
  if (score >= 64) return "medium";
  if (score >= 52) return "low";

  return "very-low";
}

function getModelBias(scan, score) {
  if (scan.signal === "WAIT") return "neutral";
  if (score >= 72 && scan.signal === "BUY") return "bullish";
  if (score >= 72 && scan.signal === "SELL") return "bearish";
  if (score < 55) return "avoid";

  return "neutral";
}

function buildNotes(scan, score, confidenceBand) {
  const notes = [];

  notes.push(`ML score ${Math.round(score)}/100`);
  notes.push(`Confidence ${confidenceBand}`);

  if (scan.pair === "BTCUSD") {
    notes.push("BTC volatility-adjusted model");
  }

  if (scan.pair === "XAUUSD") {
    notes.push("Gold volatility-adjusted model");
  }

  if (scan.signal === "WAIT") {
    notes.push("No directional signal");
  }

  if (safeNumber(scan.riskScore, 50) < 45) {
    notes.push("Risk score weak");
  }

  if (safeNumber(scan.archiveConfidence, 0) < 8) {
    notes.push("Low archive sample");
  }

  return notes;
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
