export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    if (!body.ok) {
      return json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    const payload = normalizePayload(body.data);
    const env = context.env || {};
    const groqKey = env.GROQ_API_KEY || "";

    const macroContext = await getMacroContext(
      context.request,
      payload.pair,
      payload.cooldownMinutes
    );

    const riskBlock = shouldBlockForMacro(macroContext);
    if (riskBlock.blocked) {
      return json({
        ok: true,
        decision: "NO TRADE",
        title: "Blocage macro",
        reason: riskBlock.reason,
        confidence: 93,
        action: "Ne pas entrer",
        window: `Réévaluer après ${macroContext.cooldownMinutes || payload.cooldownMinutes} min`,
        source: "macro-hard-block",
        macroSource: macroContext.source || "macro-context"
      });
    }

    const mlBlock = shouldBlockForMl(payload);
    if (mlBlock.blocked) {
      return json({
        ok: true,
        decision: "NO TRADE",
        title: "Blocage ML",
        reason: mlBlock.reason,
        confidence: 89,
        action: "Ne pas entrer",
        window: "Attendre un setup plus propre",
        source: "ml-hard-block",
        macroSource: macroContext.source || "macro-context"
      });
    }

    const journalPenalty = computeJournalPenalty(payload.journalContext);
    const mlPenalty = computeMlPenalty(payload);
    const effectiveScore = clamp(payload.finalScore - journalPenalty - mlPenalty, 0, 100);

    if (!groqKey) {
      const fallback = localDecisionEngine({
        ...payload,
        finalScore: effectiveScore,
        hiddenMacroContext: macroContext
      });

      return json({
        ok: true,
        ...fallback,
        source: "fallback-server",
        macroSource: macroContext.source || "macro-context"
      });
    }

    const groqResult = await askGroq(
      groqKey,
      { ...payload, finalScore: effectiveScore },
      macroContext
    );

    if (!groqResult.ok) {
      const fallback = localDecisionEngine({
        ...payload,
        finalScore: effectiveScore,
        hiddenMacroContext: macroContext
      });

      return json({
        ok: true,
        ...fallback,
        source: "groq-error-fallback",
        macroSource: macroContext.source || "macro-context"
      });
    }

    const parsed = parseGroqResponse(
      groqResult.data,
      { ...payload, finalScore: effectiveScore }
    );

    return json({
      ok: true,
      ...parsed,
      source: "groq",
      macroSource: macroContext.source || "macro-context"
    });
  } catch {
    return json({
      ok: true,
      decision: "WAIT",
      title: "Erreur temporaire",
      reason: "Le serveur n’a pas pu analyser la requête. Le mode prudent prend le relais.",
      confidence: 74,
      action: "Attendre",
      window: "Réessayer dans quelques minutes",
      source: "server-catch"
    });
  }
}

async function askGroq(apiKey, payload, macroContext) {
  try {
    const requestBody = {
      model: payload.model,
      temperature: 0.08,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Tu es un filtre de trading ultra strict. Réponds uniquement en JSON avec decision,title,reason,confidence,action,window. decision doit être exactement TRADE, WAIT ou NO TRADE. Si macro risquée, qualité moyenne, ou doute sur levier x10, retourne WAIT ou NO TRADE."
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
            hiddenMacroContext: macroContext,
            journalContext: payload.journalContext,
            mlScore: payload.mlScore,
            mlConfidenceBand: payload.mlConfidenceBand,
            mlExplanation: payload.mlExplanation
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

    if (!response.ok) return { ok: false };
    return { ok: true, data: await response.json() };
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
    reason: cleanText(
      parsed.reason,
      payload.mlExplanation
        ? `${payload.mlExplanation} Le moteur recommande la prudence.`
        : "Le moteur recommande la prudence."
    ),
    confidence: clamp(
      Number(parsed.confidence) || Number(payload.confidence) || 70,
      1,
      99
    ),
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
      headers: { Accept: "application/json" }
    });

    if (!response.ok) throw new Error("macro-context failed");
    const data = await response.json();

    return {
      danger: Boolean(data.danger),
      hardBlock: Boolean(data.hardBlock),
      dangerScore: Number(data.dangerScore) || 0,
      cooldownMinutes: Number(data.cooldownMinutes) || cooldownMinutes,
      source: data.source || "macro-context",
      relevantEvents: Array.isArray(data.relevantEvents)
        ? data.relevantEvents.slice(0, 10)
        : []
    };
  } catch {
    return {
      danger: false,
      hardBlock: false,
      dangerScore: 0,
      cooldownMinutes,
      source: "macro-fallback-empty",
      relevantEvents: []
    };
  }
}

function shouldBlockForMacro(macroContext) {
  if (macroContext?.hardBlock) {
    const evt = macroContext.relevantEvents?.[0];
    return {
      blocked: true,
      reason: evt
        ? `Événement macro majeur proche : ${evt.name} (${evt.currency}).`
        : "Contexte macro majeur détecté."
    };
  }

  if (Number(macroContext?.dangerScore || 0) >= 85) {
    return {
      blocked: true,
      reason: "Le contexte macro global est trop dangereux pour une entrée propre."
    };
  }

  return { blocked: false, reason: "" };
}

function shouldBlockForMl(payload) {
  const mlScore = Number(payload.mlScore || 0);

  if (mlScore > 0 && mlScore <= 30) {
    return {
      blocked: true,
      reason: "Le modèle ML considère ce setup comme trop faible."
    };
  }

  return {
    blocked: false,
    reason: ""
  };
}

function localDecisionEngine(body) {
  const hiddenMacro = body.hiddenMacroContext || {};
  const strictness = body.aiMode || "strict";
  const finalScore = Number(body.finalScore || 0);
  const gateDecision = body.gatekeeper?.decision || "WAIT";
  const confidenceBase = Number(body.confidence || 72);
  const mlScore = Number(body.mlScore || 0);

  const aggressiveBias = strictness === "aggressive" ? 5 : 0;
  const strictPenalty = strictness === "strict" ? 7 : 0;

  if (hiddenMacro.danger || hiddenMacro.hardBlock) {
    return {
      decision: "NO TRADE",
      title: "Contexte macro défavorable",
      reason: "Une fenêtre macro sensible est proche ou en cours. Le moteur bloque le trade.",
      confidence: clamp(84 + strictPenalty, 1, 99),
      action: "Ne pas entrer",
      window: `Réévaluer après ${hiddenMacro.cooldownMinutes || 90} min`
    };
  }

  if (mlScore > 0 && mlScore <= 30) {
    return {
      decision: "NO TRADE",
      title: "Refus ML",
      reason: "Le modèle juge que l’avantage statistique du setup est trop faible.",
      confidence: clamp(88 + strictPenalty, 1, 99),
      action: "Ne pas trader cet actif maintenant",
      window: "Attendre un meilleur alignement"
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

  if (gateDecision === "WAIT" || finalScore < 72 - aggressiveBias || (mlScore > 0 && mlScore <= 50)) {
    return {
      decision: "WAIT",
      title: "Attendre confirmation",
      reason: mlScore > 0 && mlScore <= 50
        ? "Le modèle ML reste trop réservé sur ce setup."
        : "Le setup existe mais l’avantage n’est pas encore assez propre pour du x10.",
      confidence: clamp(70 + strictPenalty, 1, 99),
      action: "Attendre confirmation ou meilleur timing",
      window: "Surveiller prochaine impulsion / cassure"
    };
  }

  return {
    decision: "TRADE",
    title: "Trade autorisé",
    reason: mlScore >= 80
      ? "Le contexte technique, le risque, le timing et le modèle ML sont bien alignés."
      : "Le contexte technique, le risque et le timing sont suffisamment alignés.",
    confidence: clamp(confidenceBase + 4 - strictPenalty, 1, 99),
    action: `Entrée ${(String(body.signal || "").includes("SELL")) ? "SELL" : "BUY"} possible`,
    window: "Fenêtre exploitable maintenant"
  };
}

function computeJournalPenalty(journalContext) {
  if (!journalContext || typeof journalContext !== "object") return 0;

  let penalty = 0;

  const pairExpectancy = Number(journalContext.pairExpectancy);
  const hourExpectancy = Number(journalContext.hourExpectancy);
  const sessionExpectancy = Number(journalContext.sessionExpectancy);

  const pairWinRate = Number(journalContext.pairWinRate);
  const hourWinRate = Number(journalContext.hourWinRate);
  const sessionWinRate = Number(journalContext.sessionWinRate);

  if (Number.isFinite(pairExpectancy) && pairExpectancy < 0) penalty += 8;
  if (Number.isFinite(hourExpectancy) && hourExpectancy < 0) penalty += 6;
  if (Number.isFinite(sessionExpectancy) && sessionExpectancy < 0) penalty += 6;

  if (Number.isFinite(pairWinRate) && pairWinRate < 45) penalty += 4;
  if (Number.isFinite(hourWinRate) && hourWinRate < 45) penalty += 3;
  if (Number.isFinite(sessionWinRate) && sessionWinRate < 45) penalty += 3;

  return penalty;
}

function computeMlPenalty(payload) {
  const mlScore = Number(payload.mlScore || 0);
  const band = String(payload.mlConfidenceBand || "medium");

  let penalty = 0;

  if (mlScore <= 35) penalty += 22;
  else if (mlScore <= 50) penalty += 14;
  else if (mlScore <= 60) penalty += 8;
  else if (mlScore >= 80) penalty -= 4;

  if (band === "low" && mlScore <= 50) penalty += 4;
  if (band === "high" && mlScore >= 75) penalty -= 2;

  return penalty;
}

function normalizePayload(data) {
  return {
    aiMode: oneOf(
      String(data.aiMode || "strict"),
      ["strict", "balanced", "aggressive"],
      "strict"
    ),
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
    reasons: Array.isArray(data.reasons)
      ? data.reasons.slice(0, 12).map((x) => cleanText(x, "")).filter(Boolean)
      : [],
    cooldownMinutes: clamp(Number(data.cooldownMinutes) || 90, 15, 360),
    journalContext: normalizeJournalContext(data.journalContext),
    mlScore: clamp(Number(data.mlScore) || 0, 0, 100),
    mlConfidenceBand: oneOf(
      String(data.mlConfidenceBand || "medium"),
      ["low", "medium", "high"],
      "medium"
    ),
    mlExplanation: cleanText(data.mlExplanation, "")
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

function normalizeJournalContext(ctx) {
  if (!ctx || typeof ctx !== "object") return null;
  return {
    pairExpectancy: Number(ctx.pairExpectancy),
    hourExpectancy: Number(ctx.hourExpectancy),
    sessionExpectancy: Number(ctx.sessionExpectancy),
    pairWinRate: Number(ctx.pairWinRate),
    hourWinRate: Number(ctx.hourWinRate),
    sessionWinRate: Number(ctx.sessionWinRate)
  };
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
