export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const data = body?.data || body || {};

    const decision = buildDecision(data);

    return json({
      ok: true,
      source: "local-ai-decision-engine",
      ...decision
    });
  } catch (error) {
    return json({
      ok: true,
      source: "ai-safe-fallback",
      decision: "WAIT",
      title: "Décision locale",
      reason: String(error?.message || "Fallback IA utilisé."),
      confidence: 50,
      action: "WAIT",
      window: "intraday"
    });
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    message: "POST scan data to compute AI decision."
  });
}

function buildDecision(data) {
  const pair = String(data.pair || "").toUpperCase();
  const isGold = pair === "XAUUSD";

  const ultra = num(data.ultraScore, data.finalScore || 50);
  const finalScore = num(data.finalScore, 50);
  const ml = num(data.mlScore, 50);
  const vectorbt = num(data.vectorbtScore, 50);
  const archive = num(data.archiveEdgeScore, 50);
  const session = num(data.sessionScore, 50);
  const execution = num(data.executionScore, 50);
  const risk = num(data.riskScore, 50);
  const tradeStatus = String(data.tradeStatus || "").toUpperCase();
  const signal = String(data.signal || "WAIT").toUpperCase();

  const confidence = clamp(
    ultra * 0.38 +
      finalScore * 0.18 +
      archive * 0.16 +
      session * 0.10 +
      execution * 0.10 +
      ml * 0.04 +
      vectorbt * 0.04,
    1,
    99
  );

  if (tradeStatus.includes("SNIPER GOLD")) {
    return {
      decision: "TRADE",
      title: "SNIPER GOLD",
      reason: "Structure gold, archive et session alignées. Setup prioritaire.",
      confidence: Math.round(confidence),
      action: signal === "SELL" ? "SELL" : "BUY",
      window: "M15 intraday"
    };
  }

  if (tradeStatus.includes("VALID GOLD")) {
    return {
      decision: "TRADE",
      title: "VALID GOLD",
      reason: "Gold validé par confluence archive/session. Risque à garder réduit.",
      confidence: Math.round(confidence),
      action: signal === "SELL" ? "SELL" : "BUY",
      window: "M15 intraday"
    };
  }

  if (tradeStatus.includes("WATCH GOLD")) {
    return {
      decision: "WAIT",
      title: "WATCH GOLD",
      reason: "Gold prometteur mais pas encore assez propre pour exécuter.",
      confidence: Math.round(confidence),
      action: "WAIT",
      window: "attendre confirmation"
    };
  }

  if (tradeStatus.includes("BLOCKED GOLD")) {
    return {
      decision: "NO TRADE",
      title: "BLOCKED GOLD",
      reason: "Setup gold insuffisamment confirmé ou danger trop élevé.",
      confidence: Math.round(confidence),
      action: "WAIT",
      window: "no trade"
    };
  }

  if (tradeStatus.includes("SNIPER")) {
    return {
      decision: "TRADE",
      title: "SNIPER SETUP",
      reason: "Confluence forte entre score ultra, archive et exécution.",
      confidence: Math.round(confidence),
      action: signal === "SELL" ? "SELL" : "BUY",
      window: "M15 intraday"
    };
  }

  if (tradeStatus.includes("VALID")) {
    return {
      decision: "TRADE",
      title: "VALID SETUP",
      reason: "Setup exploitable avec risque contrôlé.",
      confidence: Math.round(confidence),
      action: signal === "SELL" ? "SELL" : "BUY",
      window: "M15 intraday"
    };
  }

  if (tradeStatus.includes("WATCH")) {
    return {
      decision: "WAIT",
      title: "WATCHLIST",
      reason: "Setup intéressant mais confirmation encore insuffisante.",
      confidence: Math.round(confidence),
      action: "WAIT",
      window: "surveillance"
    };
  }

  if (risk < 30) {
    return {
      decision: "NO TRADE",
      title: "RISK BLOCK",
      reason: "Risque trop élevé pour FTMO.",
      confidence: Math.round(confidence),
      action: "WAIT",
      window: "no trade"
    };
  }

  if (isGold && ultra >= 64 && archive >= 58 && session >= 58) {
    return {
      decision: "WAIT",
      title: "GOLD NEAR VALID",
      reason: "Gold proche d’un setup valide, mais le filtre final attend une confirmation.",
      confidence: Math.round(confidence),
      action: "WAIT",
      window: "attendre prochaine bougie"
    };
  }

  if (ultra >= 68 && archive >= 58 && execution >= 54) {
    return {
      decision: "TRADE",
      title: "VALID LOCAL",
      reason: "Le moteur local autorise une entrée prudente.",
      confidence: Math.round(confidence),
      action: signal === "SELL" ? "SELL" : "BUY",
      window: "M15 intraday"
    };
  }

  return {
    decision: "WAIT",
    title: "NO CLEAN ENTRY",
    reason: "Pas assez de confluence pour exécuter maintenant.",
    confidence: Math.round(confidence),
    action: "WAIT",
    window: "attendre"
  };
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
