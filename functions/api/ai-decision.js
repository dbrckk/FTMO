export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    if (!body.ok) {
      return json(
        {
          ok: false,
          error: "Invalid JSON body"
        },
        400
      );
    }

    const payload = normalizePayload(body.data);
    const env = context.env || {};
    const groqKey = env.GROQ_API_KEY;

    const macroContext = await getMacroContext(context.request, payload.pair, payload.cooldownMinutes);

    if (!groqKey) {
      const fallback = localDecisionEngine({
        ...payload,
        hiddenMacroContext: macroContext
      });

      return json({
        ok: true,
        ...fallback,
        source: "fallback-server",
        macroSource: macroContext.source || "macro-fallback"
      });
    }

    const groqResult = await askGroq(groqKey, payload, macroContext);

    if (!groqResult.ok) {
      const fallback = localDecisionEngine({
        ...payload,
        hiddenMacroContext: macroContext
      });

      return json({
        ok: true,
        ...fallback,
        source: "groq-error-fallback",
        macroSource: macroContext.source || "macro-fallback"
      });
    }

    const parsed = parseGroqResponse(groqResult.data, payload);

    return json({
      ok: true,
      ...parsed,
      source: "groq",
      macroSource: macroContext.source || "macro-fallback"
    });
  } catch (error) {
    return json(
      {
        ok: true,
        decision: "WAIT",
        title: "Erreur temporaire",
        reason: "Le serveur n’a pas pu analyser la requête. Le mode prudent prend le relais.",
        confidence: 74,
        action: "Attendre",
        window: "Réessayer dans quelques minutes",
        source: "server-catch"
      },
      200
    );
  }
}

async function askGroq(apiKey, payload, macroContext) {
  try {
    const requestBody = {
      model: payload.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Tu es un filtre de trading ultra strict. Tu réponds uniquement en JSON avec les clés decision,title,reason,confidence,action,window. decision doit être exactement TRADE, WAIT ou NO TRADE. Si le moindre doute existe, retourne WAIT ou NO TRADE. Tu dois prendre en compte le contexte macro caché, la qualité du setup, le levier x10, et ne jamais promettre un gain certain."
        },
        {
          role: "user",
          content: JSON.stringify({
            aiMode: payload.aiMode,
            leverage: payload.leverage,
            pair: payload.pair,
            timeframe: payload.timeframe,
            signal: payload.signal,
            trend: payload.trend,
            finalScore: payload.finalScore,
            confidence: payload.confidence,
            trendScore: payload.trendScore,
            timingScore: payload.timingScore,
            riskScore: payload.riskScore,
            contextScore: payload.contextScore,
            rr: payload.rr,
            gatekeeper: payload.gatekeeper,
            reasons: payload.reasons,
            hiddenMacroContext: macroContext
          })
        }
      ]
    };

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      return { ok: false };
    }

    const data = await response.json();
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

function parseGroqResponse(groqData, payload) {
  const content = groqData?.choices?.[0]?.message?.content || "{}";

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = localDecisionEngine(payload);
  }

  return {
    decision: sanitizeDecision(parsed.decision),
    title: cleanText(parsed.title, "Décision IA"),
    reason: cleanText(parsed.reason, "Le moteur recommande la prudence."),
    confidence: clamp(Number(parsed.confidence) || Number(payload.confidence) || 70, 1, 99),
    action: cleanText(parsed.action, "Attendre une meilleure fenêtre"),
    window: cleanText(parsed.window, "À revalider au prochain refresh")
  };
}

async function getMacroContext(request, pair, cooldownMinutes) {
  try {
    const url = new URL(request.url);
    url.pathname = "/api/macro-context";
    url.search = `?pair=${encodeURIComponent(pair)}&cooldown=${encodeURIComponent(String(cooldownMinutes))}`;

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error("macro fetch failed");
    }

    const data = await response.json();

    return {
      danger: Boolean(data.danger),
      cooldownMinutes: Number(data.cooldownMinutes) || cooldownMinutes,
      source: data.source || "macro-endpoint",
      relevantEvents: Array.isArray(data.relevantEvents) ? data.relevantEvents.slice(0, 10) : []
    };
  } catch {
    return {
      danger: false,
      cooldownMinutes,
      source: "macro-fallback-empty",
      relevantEvents: []
    };
  }
}

function localDecisionEngine(body) {
  const hiddenMacro = body.hiddenMacroContext || {};
  const strictness = body.aiMode || "strict";
  const finalScore = Number(body.finalScore || 0);
  const gateDecision = body.gatekeeper?.decision || "WAIT";
  const confidenceBase = Number(body.confidence || 72);

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
      reason: "Le garde-fou détecte trop de points faibles sur le risque, le contexte ou la qualité du setup.",
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
    reason: "Le contexte technique, le risque et le timing sont suffisamment alignés selon les critères stricts du moteur.",
    confidence: clamp(confidenceBase + 4 - strictPenalty, 1, 99),
    action: `Entrée ${(String(body.signal || "").includes("SELL")) ? "SELL" : "BUY"} possible`,
    window: "Fenêtre exploitable maintenant"
  };
}

function normalizePayload(data) {
  return {
    aiMode: oneOf(String(data.aiMode || "strict"), ["strict", "balanced", "aggressive"], "strict"),
    model: cleanModel(data.model),
    leverage: "x10",
    pair: cleanPair(data.pair),
    timeframe: cleanText(data.timeframe, "M15"),
    signal: cleanText(data.signal, "WAIT"),
    trend: cleanText(data.trend, "Neutral"),
    finalScore: clamp(Number(data.finalScore) || 0, 0, 100),
    confidence: clamp(Number(data.confidence) || 70, 1, 99),
    trendScore: clamp(Number(data.trendScore) || 0, 0, 100),
    timingScore: clamp(Number(data.timingScore) || 0, 0, 100),
    riskScore: clamp(Number(data.riskScore) || 0, 0, 100),
    contextScore: clamp(Number(data.contextScore) || 0, 0, 100),
    rr: cleanText(data.rr, "0.00"),
    gatekeeper: normalizeGatekeeper(data.gatekeeper),
    reasons: Array.isArray(data.reasons) ? data.reasons.slice(0, 12).map((x) => cleanText(x, "")).filter(Boolean) : [],
    cooldownMinutes: clamp(Number(data.cooldownMinutes) || 90, 15, 240)
  };
}

function normalizeGatekeeper(gatekeeper) {
  const decision = sanitizeDecision(gatekeeper?.decision || "WAIT");
  const checks = Array.isArray(gatekeeper?.checks)
    ? gatekeeper.checks.slice(0, 8).map((check) => ({
        label: cleanText(check?.label, "Check"),
        ok: Boolean(check?.ok),
        value: cleanText(check?.value, "")
      }))
    : [];

  return { decision, checks };
}

function cleanModel(value) {
  const allowed = [
    "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-20b"
  ];
  return oneOf(String(value || ""), allowed, "llama-3.1-8b-instant");
}

function cleanPair(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10) || "EURUSD";
}

function sanitizeDecision(value) {
  const normalized = String(value || "").toUpperCase().trim();
  if (normalized.includes("NO")) return "NO TRADE";
  if (normalized.includes("WAIT")) return "WAIT";
  return "TRADE";
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function cleanText(value, fallback) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 500) : fallback;
}

async function safeJson(request) {
  try {
    return { ok: true, data: await request.json() };
  } catch {
    return { ok: false };
  }
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
