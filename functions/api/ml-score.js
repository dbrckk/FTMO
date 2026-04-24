export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const data = body?.data || body || {};

    const score = computeMlLikeScore(data);
    const confidenceBand =
      score >= 78 ? "high" :
      score >= 62 ? "medium-high" :
      score >= 45 ? "medium" :
      "low";

    return json({
      ok: true,
      source: "local-ml-engine",
      mlScore: score,
      confidenceBand,
      explanation: buildExplanation(data, score)
    });
  } catch (error) {
    return json({
      ok: true,
      source: "ml-safe-fallback",
      mlScore: 50,
      confidenceBand: "medium",
      explanation: String(error?.message || "ML fallback utilisé.")
    });
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    message: "POST scan data to compute ML score."
  });
}

function computeMlLikeScore(data) {
  const trend = num(data.trendScore, 50);
  const timing = num(data.timingScore, 50);
  const risk = num(data.riskScore, 50);
  const context = num(data.contextScore, 50);
  const entryTrigger = num(data.entryTriggerScore, 50);
  const entrySniper = num(data.entrySniperScore, 50);
  const rsi14 = num(data.rsi14, 50);
  const macdLine = num(data.macdLine, 0);
  const momentum = num(data.momentum, 0);
  const rr = num(data.rr, 1.5);

  const pairExpectancy = num(data.pairExpectancy, 0);
  const hourExpectancy = num(data.hourExpectancy, 0);
  const sessionExpectancy = num(data.sessionExpectancy, 0);
  const pairWinRate = num(data.pairWinRate, 50);
  const hourWinRate = num(data.hourWinRate, 50);
  const sessionWinRate = num(data.sessionWinRate, 50);

  const rsiScore = scoreRsi(rsi14);
  const macdScore = macdLine >= 0 ? 58 : 42;
  const momentumScore = momentum >= 0 ? 58 : 42;
  const rrScore = clamp(rr * 22, 1, 99);

  const archiveScore = clamp(
    50 +
      (pairExpectancy * 18) +
      (hourExpectancy * 12) +
      (sessionExpectancy * 14) +
      ((pairWinRate - 50) * 0.35) +
      ((hourWinRate - 50) * 0.22) +
      ((sessionWinRate - 50) * 0.25),
    1,
    99
  );

  let score =
    trend * 0.18 +
    timing * 0.20 +
    risk * 0.12 +
    context * 0.10 +
    entryTrigger * 0.12 +
    entrySniper * 0.08 +
    rsiScore * 0.07 +
    macdScore * 0.04 +
    momentumScore * 0.04 +
    rrScore * 0.03 +
    archiveScore * 0.02;

  if (data.pair === "XAUUSD") {
    score =
      trend * 0.16 +
      timing * 0.18 +
      risk * 0.10 +
      context * 0.10 +
      entryTrigger * 0.13 +
      entrySniper * 0.08 +
      rsiScore * 0.06 +
      macdScore * 0.04 +
      momentumScore * 0.05 +
      rrScore * 0.04 +
      archiveScore * 0.06;
  }

  return Math.round(clamp(score, 1, 99));
}

function buildExplanation(data, score) {
  const pair = String(data.pair || "pair");
  const rr = num(data.rr, 0).toFixed(2);
  const momentum = num(data.momentum, 0);

  if (score >= 78) {
    return `${pair}: confluence forte, RR ${rr}, momentum ${momentum >= 0 ? "positif" : "faible"}.`;
  }

  if (score >= 62) {
    return `${pair}: setup correct mais demande confirmation execution/archive. RR ${rr}.`;
  }

  if (score >= 45) {
    return `${pair}: signal moyen, pas assez propre pour être prioritaire.`;
  }

  return `${pair}: score faible, risque de faux signal élevé.`;
}

function scoreRsi(rsi) {
  const value = num(rsi, 50);

  if (value >= 45 && value <= 62) return 68;
  if (value > 62 && value <= 70) return 56;
  if (value >= 35 && value < 45) return 54;
  if (value > 70) return 34;
  if (value < 30) return 32;

  return 50;
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function num(value, fallback = 0) {
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
