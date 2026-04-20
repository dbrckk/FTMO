export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const env = context.env || {};
    const groqKey = env.GROQ_API_KEY;

    if (!groqKey) {
      return json({
        decision: localDecisionEngine(body),
        source: "fallback-server"
      });
    }

    const promptPayload = {
      aiMode: body.aiMode || "strict",
      leverage: body.leverage || "x10",
      pair: body.pair,
      timeframe: body.timeframe,
      signal: body.signal,
      trend: body.trend,
      finalScore: body.finalScore,
      confidence: body.confidence,
      trendScore: body.trendScore,
      timingScore: body.timingScore,
      riskScore: body.riskScore,
      contextScore: body.contextScore,
      rr: body.rr,
      gatekeeper: body.gatekeeper,
      reasons: body.reasons,
      hiddenMacroContext: body.hiddenMacroContext
    };

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: body.model || "llama-3.1-8b-instant",
        temperature: 0.15,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Tu es un filtre de trading ultra strict. Réponds uniquement en JSON avec les clés decision,title,reason,confidence,action,window. decision doit être TRADE, WAIT ou NO TRADE. Si le doute existe, retourne WAIT ou NO TRADE. Tu dois utiliser le contexte macro caché pour bloquer un trade si besoin."
          },
          {
            role: "user",
            content: JSON.stringify(promptPayload)
          }
        ]
      })
    });

    if (!groqRes.ok) {
      const fallback = localDecisionEngine(body);
      return json({ ...fallback, source: "groq-error-fallback" }, 200);
    }

    const groqData = await groqRes.json();
    const content = groqData?.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = localDecisionEngine(body);
    }

    const output = {
      decision: sanitizeDecision(parsed.decision),
      title: parsed.title || "Décision IA",
      reason: parsed.reason || "Le moteur recommande la prudence.",
      confidence: clamp(Number(parsed.confidence) || Number(body.confidence) || 70, 1, 99),
      action: parsed.action || "Attendre une meilleure fenêtre",
      window: parsed.window || "À revalider au prochain refresh",
      source: "groq"
    };

    return json(output);
  } catch {
    return json({
      decision: "WAIT",
      title: "Erreur temporaire",
      reason: "Le serveur n’a pas pu analyser la requête. Le mode prudent prend le relais.",
      confidence: 74,
      action: "Attendre",
      window: "Réessayer dans quelques minutes",
      source: "server-catch"
    }, 200);
  }
}

function localDecisionEngine(body) {
  const hiddenMacro = body.hiddenMacroContext || {};
  const strictness = body.aiMode || "strict";
  const finalScore = Number(body.finalScore || 0);
  const gateDecision = body.gatekeeper?.decision || "WAIT";

  const aggressiveBias = strictness === "aggressive" ? 5 : 0;
  const strictPenalty = strictness === "strict" ? 7 : 0;

  if (hiddenMacro.danger) {
    return {
      decision: "NO TRADE",
      title: "Contexte macro défavorable",
      reason: "Une fenêtre macro sensible est proche ou en cours. Le moteur serveur bloque le trade.",
      confidence: clamp(82 + strictPenalty, 1, 99),
      action: "Ne pas entrer",
      window: `Réévaluer après ${hiddenMacro.cooldownMinutes || 90} min`
    };
  }

  if (gateDecision === "NO TRADE") {
    return {
      decision: "NO TRADE",
      title: "Trade refusé",
      reason: "Le garde-fou détecte trop de points faibles sur risque, contexte ou qualité du setup.",
      confidence: clamp(86 + strictPenalty, 1, 99),
      action: "Ne pas trader cet actif maintenant",
      window: "Attendre une restructuration du prix"
    };
  }

  if (gateDecision === "WAIT" || finalScore < 72 - aggressiveBias) {
    return {
      decision: "WAIT",
      title: "Attendre confirmation",
      reason: "Le setup existe mais l’avantage n’est pas encore assez propre pour du x10.",
      confidence: clamp(70 + strictPenalty, 1, 99),
      action: "Attendre confirmation ou meilleur timing",
      window: "Surveiller prochaine impulsion / cassure"
    };
  }

  return {
    decision: "TRADE",
    title: "Trade autorisé",
    reason: "Le contexte technique, le risque et le timing sont suffisamment alignés.",
    confidence: clamp(Number(body.confidence || 78) + 4 - strictPenalty, 1, 99),
    action: `Entrée ${(body.signal || "").includes("SELL") ? "SELL" : "BUY"} possible`,
    window: "Fenêtre exploitable maintenant"
  };
}

function sanitizeDecision(value) {
  const normalized = String(value || "").toUpperCase().trim();
  if (normalized.includes("NO")) return "NO TRADE";
  if (normalized.includes("WAIT")) return "WAIT";
  return "TRADE";
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
