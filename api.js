import { API } from "./config.js";
import { appState, persistState } from "./state.js";
import { clamp, sanitizeDecision } from "./utils.js";

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${url} ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchArchiveStatsBatch() {
  try {
    const url = new URL(API.archiveStats, window.location.origin);
    url.searchParams.set("timeframe", appState.timeframe || "M15");

    const data = await fetchJsonWithTimeout(
      url.toString(),
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      },
      4000
    );

    appState.archiveStatsCache = data.stats || {};
    appState.archiveStatsUpdatedAt = new Date().toISOString();
    persistState();

    return appState.archiveStatsCache;
  } catch {
    appState.archiveStatsCache = appState.archiveStatsCache || {};
    return appState.archiveStatsCache;
  }
}

export async function fetchServerPaperSnapshot() {
  try {
    const url = new URL(API.paperTrades, window.location.origin);
    url.searchParams.set("mode", "snapshot");
    url.searchParams.set("timeframe", appState.timeframe || "M15");

    const data = await fetchJsonWithTimeout(
      url.toString(),
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      },
      4000
    );

    appState.serverPaperSnapshot = data || null;
    persistState();

    return data;
  } catch {
    appState.serverPaperSnapshot = appState.serverPaperSnapshot || null;
    return appState.serverPaperSnapshot;
  }
}

export async function saveClosedPaperTrade(trade) {
  try {
    return await fetchJsonWithTimeout(
      API.paperTrades,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(trade)
      },
      4000
    );
  } catch {
    return { ok: false };
  }
}

export async function fetchMlScore(scan) {
  try {
    const journalContext = buildJournalContextForPair(scan) || {};

    const data = await fetchJsonWithTimeout(
      API.ml,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          data: {
            pair: scan.pair,
            timeframe: appState.timeframe,
            trendScore: scan.trendScore,
            timingScore: scan.timingScore,
            riskScore: scan.riskScore,
            contextScore: scan.contextScore,
            entryTriggerScore: scan.entryTriggerScore || 0,
            entrySniperScore: scan.entrySniper?.score || 0,
            exitSniperScore: scan.exitSniper?.score || 0,
            rsi14: scan.rsi14 || 50,
            macdLine: scan.macdLine || 0,
            atr14: scan.atr14 || 0,
            momentum: scan.momentum || 0,
            rr: scan.rr || 1.5,
            pairExpectancy: journalContext.pairExpectancy || 0,
            hourExpectancy: journalContext.hourExpectancy || 0,
            sessionExpectancy: journalContext.sessionExpectancy || 0,
            pairWinRate: journalContext.pairWinRate || 0,
            hourWinRate: journalContext.hourWinRate || 0,
            sessionWinRate: journalContext.sessionWinRate || 0
          }
        })
      },
      4500
    );

    appState.mlScoreCache[scan.pair] = data;
    return data;
  } catch {
    const fallback = {
      ok: true,
      source: "ml-fallback",
      mlScore: clamp(
        Math.round(
          scan.trendScore * 0.22 +
          scan.timingScore * 0.26 +
          scan.riskScore * 0.20 +
          scan.contextScore * 0.14 +
          (scan.entryTriggerScore || 50) * 0.18
        ),
        1,
        99
      ),
      confidenceBand: "medium",
      explanation: "Score ML indisponible, fallback local utilisé."
    };

    appState.mlScoreCache[scan.pair] = fallback;
    return fallback;
  }
}

export async function fetchVectorbtScore(scan) {
  try {
    const data = await fetchJsonWithTimeout(
      API.vectorbt,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          data: {
            pair: scan.pair,
            timeframe: appState.timeframe,
            candles: scan.candles,
            fee: 0.0002,
            slippage: 0.0001,
            fast_ema: 20,
            slow_ema: 50,
            rsi_period: 14,
            atr_period: 14,
            macd_fast: 12,
            macd_slow: 26,
            macd_signal: 9,
            rsi_buy_min: 45,
            rsi_buy_max: 65,
            rsi_sell_min: 35,
            rsi_sell_max: 55,
            stop_atr_mult: 1.4,
            take_atr_mult: 2.6
          }
        })
      },
      3500
    );

    appState.vectorbtCache[scan.pair] = data;
    return data;
  } catch {
    const fallback = {
      ok: true,
      source: "vectorbt-fallback",
      vectorbtScore: 55,
      confidenceBand: "medium",
      explanation: "VectorBT indisponible, fallback neutre utilisé.",
      metrics: {
        totalReturnPct: 0,
        winRatePct: 0,
        maxDrawdownPct: 0,
        totalTrades: 0,
        profitFactor: 0,
        sharpeRatio: 0,
        expectancy: 0
      }
    };

    appState.vectorbtCache[scan.pair] = fallback;
    return fallback;
  }
}

export async function fetchCorrelationMatrix() {
  try {
    const rows = appState.scans.slice(0, 25).map((scan) => ({
      pair: scan.pair,
      closes: scan.candles.map((c) => c.close).slice(-120)
    }));

    const data = await fetchJsonWithTimeout(
      API.correlation,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ rows })
      },
      4000
    );

    appState.correlationMatrix = data;
    persistState();

    return data;
  } catch {
    appState.correlationMatrix = null;
    return null;
  }
}

export async function fetchPortfolioRisk() {
  try {
    const positions = appState.trades
      .filter((t) => t.status === "active")
      .map((t) => ({
        pair: t.pair,
        riskPercent: Number(t.riskPercent || 0)
      }));

    const data = await fetchJsonWithTimeout(
      API.portfolio,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ positions })
      },
      4000
    );

    appState.portfolioRiskData = data;
    persistState();

    return data;
  } catch {
    appState.portfolioRiskData = {
      ok: false,
      decision: "REDUCE",
      reason: "Portfolio risk unavailable."
    };

    return appState.portfolioRiskData;
  }
}

export async function refreshAiDecision(force = false, renderSelectedPair) {
  const scan = appState.scans.find((s) => s.pair === appState.selectedPair);
  if (!scan) return;

  if (!force && appState.aiDecisionCache?.[scan.pair]) {
    renderSelectedPair();
    return;
  }

  try {
    const data = await fetchJsonWithTimeout(
      API.ai,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          data: {
            pair: scan.pair,
            timeframe: appState.timeframe,
            finalScore: scan.finalScore,
            ultraScore: scan.ultraScore,
            trendScore: scan.trendScore,
            timingScore: scan.timingScore,
            riskScore: scan.riskScore,
            contextScore: scan.contextScore,
            mlScore: scan.mlScore,
            vectorbtScore: scan.vectorbtScore,
            archiveEdgeScore: scan.archiveEdgeScore,
            sessionScore: scan.sessionScore,
            executionScore: scan.executionScore,
            tradeStatus: scan.tradeStatus,
            signal: scan.signal
          }
        })
      },
      4000
    );

    appState.aiDecisionCache[scan.pair] = {
      decision: sanitizeDecision(data.decision),
      title: data.title || "Décision IA",
      reason: data.reason || "Décision générée.",
      confidence: Number(data.confidence || scan.ultraScore || scan.finalScore || 0),
      action: data.action || (scan.tradeAllowed ? "EXECUTE" : "WAIT"),
      window: data.window || "intraday"
    };
  } catch {
    appState.aiDecisionCache[scan.pair] = {
      decision: scan.tradeAllowed ? "TRADE" : "WAIT",
      title: scan.tradeStatus || "Fallback IA",
      reason: scan.tradeReason || "Décision locale utilisée.",
      confidence: Number(scan.ultraScore || scan.finalScore || 0),
      action: scan.tradeAllowed ? "EXECUTE" : "WAIT",
      window: "intraday"
    };
  }

  persistState();
  renderSelectedPair();
}

export async function fetchExitSuggestion(scan, ai, targetEl) {
  if (!targetEl) return;

  try {
    const data = await fetchJsonWithTimeout(
      API.exit,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          data: {
            pair: scan.pair,
            direction: scan.direction,
            entry: Number(document.getElementById("tradeEntry")?.value || scan.current),
            currentPrice: scan.current,
            stopLoss: scan.stopLoss,
            takeProfit: scan.takeProfit,
            atr14: scan.atr14,
            macroDanger: ai?.decision === "NO TRADE",
            momentum: scan.momentum,
            confidence: ai?.confidence || scan.ultraScore || scan.finalScore
          }
        })
      },
      3500
    );

    targetEl.innerHTML = `
      <strong>${data.decision}</strong><br>
      R multiple: ${data.rMultiple ?? "--"}<br>
      Progression TP: ${data.tpProgress ?? "--"}<br>
      Sortie partielle: ${data.partialClosePercent ?? "--"}%<br>
      Nouveau stop: ${data.newStopLoss ?? "--"}<br>
      Motif: ${data.reason || "--"}
    `;
  } catch {
    targetEl.innerHTML = `
      <strong>EXIT ENGINE INDISPONIBLE</strong><br>
      Utilise le mode hold.
    `;
  }
}

export function buildJournalContextForPair(scan) {
  const pair = scan?.pair || "";
  const stats = appState.archiveStatsCache?.[pair];

  if (!stats) {
    return {
      pairExpectancy: 0,
      hourExpectancy: 0,
      sessionExpectancy: 0,
      pairWinRate: 0,
      hourWinRate: 0,
      sessionWinRate: 0
    };
  }

  const now = new Date();

  const hour = Number(
    now.toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );

  const session = getCurrentSession(hour);
  const hourStats = stats.hours?.[String(hour)] || {};
  const sessionStats = stats.sessions?.[session] || {};

  return {
    pairExpectancy: Number(stats.pairExpectancy ?? 0),
    hourExpectancy: Number(hourStats.expectancy ?? 0),
    sessionExpectancy: Number(sessionStats.expectancy ?? 0),
    pairWinRate: Number(stats.pairWinRate ?? 0),
    hourWinRate: Number(hourStats.winRate ?? 0),
    sessionWinRate: Number(sessionStats.winRate ?? 0)
  };
}

function getCurrentSession(hour) {
  const tokyo = hour >= 1 && hour < 10;
  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const overlap = london && newYork;

  if (overlap) return "London+NewYork";
  if (london) return "London";
  if (newYork) return "NewYork";
  if (tokyo) return "Tokyo";

  return "OffSession";
  }
