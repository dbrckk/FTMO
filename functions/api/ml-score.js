export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    const features = normalizeFeatures(body);
    const ruleScore = computeRuleScore(features);
    const mlScore = computePseudoMlScore(features, ruleScore);

    return json({
      ok: true,
      source: "rule-ml-v1",
      mlScore,
      confidenceBand: getConfidenceBand(mlScore),
      features,
      explanation: buildExplanation(features, mlScore)
    });
  } catch {
    return json(
      {
        ok: false,
        error: "Invalid payload"
      },
      400
    );
  }
}

function normalizeFeatures(body) {
  return {
    pair: cleanText(body.pair, "EURUSD"),
    timeframe: cleanText(body.timeframe, "M15"),
    trendScore: clamp(Number(body.trendScore) || 0, 0, 100),
    timingScore: clamp(Number(body.timingScore) || 0, 0, 100),
    riskScore: clamp(Number(body.riskScore) || 0, 0, 100),
    contextScore: clamp(Number(body.contextScore) || 0, 0, 100),
    entryTriggerScore: clamp(Number(body.entryTriggerScore) || 0, 0, 100),
    entrySniperScore: clamp(Number(body.entrySniperScore) || 0, 0, 100),
    exitSniperScore: clamp(Number(body.exitSniperScore) || 0, 0, 100),
    rsi14: clamp(Number(body.rsi14) || 50, 0, 100),
    macdLine: Number(body.macdLine) || 0,
    atr14: Math.max(Number(body.atr14) || 0, 0),
    momentum: Number(body.momentum) || 0,
    rr: Math.max(Number(body.rr) || 0, 0),
    macroPenalty: clamp(Number(body.macroPenalty) || 0, 0, 100),
    spreadPenalty: clamp(Number(body.spreadPenalty) || 0, 0, 100),
    offSessionPenalty: clamp(Number(body.offSessionPenalty) || 0, 0, 100),
    pairExpectancy: Number(body.pairExpectancy) || 0,
    hourExpectancy: Number(body.hourExpectancy) || 0,
    sessionExpectancy: Number(body.sessionExpectancy) || 0,
    pairWinRate: clamp(Number(body.pairWinRate) || 0, 0, 100),
    hourWinRate: clamp(Number(body.hourWinRate) || 0, 0, 100),
    sessionWinRate: clamp(Number(body.sessionWinRate) || 0, 0, 100)
  };
}

function computeRuleScore(f) {
  let score = 50;

  score += weighted(f.trendScore, 70, 12);
  score += weighted(f.timingScore, 70, 14);
  score += weighted(f.riskScore, 65, 12);
  score += weighted(f.contextScore, 65, 10);
  score += weighted(f.entryTriggerScore, 70, 14);
  score += weighted(f.entrySniperScore, 72, 14);
  score += weighted(f.exitSniperScore, 65, 6);

  if (f.rr >= 2) score += 8;
  else if (f.rr >= 1.6) score += 4;
  else if (f.rr < 1.2) score -= 8;

  if (f.rsi14 >= 45 && f.rsi14 <= 65) score += 6;
  else if (f.rsi14 > 74 || f.rsi14 < 26) score -= 8;

  if (f.macdLine > 0) score += 4;
  else score -= 2;

  if (Math.abs(f.momentum) >= 0.08) score += 5;
  else score -= 5;

  score -= f.macroPenalty * 1.4;
  score -= f.spreadPenalty * 0.8;
  score -= f.offSessionPenalty * 0.9;

  if (f.pairExpectancy > 0) score += Math.min(8, f.pairExpectancy * 6);
  if (f.hourExpectancy > 0) score += Math.min(5, f.hourExpectancy * 5);
  if (f.sessionExpectancy > 0) score += Math.min(5, f.sessionExpectancy * 5);

  if (f.pairExpectancy < 0) score += Math.max(-10, f.pairExpectancy * 8);
  if (f.hourExpectancy < 0) score += Math.max(-6, f.hourExpectancy * 6);
  if (f.sessionExpectancy < 0) score += Math.max(-6, f.sessionExpectancy * 6);

  if (f.pairWinRate >= 55) score += 4;
  else if (f.pairWinRate > 0 && f.pairWinRate < 45) score -= 5;

  if (f.hourWinRate >= 55) score += 3;
  else if (f.hourWinRate > 0 && f.hourWinRate < 45) score -= 3;

  if (f.sessionWinRate >= 55) score += 3;
  else if (f.sessionWinRate > 0 && f.sessionWinRate < 45) score -= 3;

  return clamp(Math.round(score), 1, 99);
}

function computePseudoMlScore(features, ruleScore) {
  let score = ruleScore;

  const interactionBonus =
    (
      (features.trendScore >= 70 ? 1 : 0) +
      (features.timingScore >= 70 ? 1 : 0) +
      (features.entrySniperScore >= 72 ? 1 : 0) +
      (features.riskScore >= 65 ? 1 : 0)
    ) >= 3;

  if (interactionBonus) score += 6;

  const weakCluster =
    features.macroPenalty >= 4 &&
    features.offSessionPenalty >= 7 &&
    features.spreadPenalty >= 8;

  if (weakCluster) score -= 12;

  const journalTailwind =
    features.pairExpectancy > 0 &&
    features.hourExpectancy > 0 &&
    features.sessionExpectancy > 0;

  if (journalTailwind) score += 5;

  const journalHeadwind =
    features.pairExpectancy < 0 &&
    features.hourExpectancy < 0;

  if (journalHeadwind) score -= 10;

  return clamp(Math.round(score), 1, 99);
}

function buildExplanation(f, mlScore) {
  if (mlScore >= 80) {
    return "Setup très propre : alignement technique, timing et risque favorable.";
  }

  if (mlScore >= 65) {
    return "Setup correct mais encore sélectif, à confirmer par le filtre IA final.";
  }

  if (mlScore >= 50) {
    return "Setup moyen : l’avantage statistique n’est pas assez propre.";
  }

  return "Setup faible : trop de frictions sur le risque, le timing ou le contexte.";
}

function getConfidenceBand(score) {
  if (score >= 80) return "high";
  if (score >= 65) return "medium";
  return "low";
}

function weighted(value, threshold, bonus) {
  if (value >= threshold) return bonus;
  if (value >= threshold - 10) return Math.round(bonus * 0.4);
  if (value <= threshold - 20) return -Math.round(bonus * 0.5);
  return 0;
}

function cleanText(value, fallback) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 60) : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
