// api.fixed.js

import { API } from "./config.js";
import { appState, persistState } from "./state.js";
import { clamp, sanitizeDecision } from "./utils.js";

export async function fetchMlScore(scan) {
  try {
    const journalContext = buildJournalContextForPair(scan) || {};

    const response = await fetch(API.ml, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
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
          macroPenalty: scan.macroPenalty || 0,
          spreadPenalty: scan.spreadPenalty || 0,
          offSessionPenalty: scan.offSessionPenalty || 0,
          pairExpectancy: journalContext.pairExpectancy || 0,
          hourExpectancy: journalContext.hourExpectancy || 0,
          sessionExpectancy: journalContext.sessionExpectancy || 0,
          pairWinRate: journalContext.pairWinRate || 0,
          hourWinRate: journalContext.hourWinRate || 0,
          sessionWinRate: journalContext.sessionWinRate || 0
        }
      })
    });

    if (!response.ok) {
      throw new Error(`ml-score ${response.status}`);
    }

    const data = await response.json();
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
    const response = await fetch(API.vectorbt, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
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
    });

    if (!response.ok) {
      throw new Error(`vectorbt-score ${response.status}`);
    }

    const data = await response.json();
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
    const rows = appState.scans.slice(0, 10).map((scan) => ({
      pair: scan.pair,
      closes: scan.candles.map((c) => c.close).slice(-120)
    }));

    const response = await fetch(API.correlation, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ rows })
    });

    if (!response.ok) {
      throw new Error(`correlation-matrix ${response.status}`);
    }

    const data = await response.json();
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

    const response = await fetch(API.portfolio, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ positions })
    });

    if (!response.ok) {
      throw new Error(`portfolio-risk ${response.status}`);
    }

    const data = await response.json();
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
    const response = await fetch(API.ai, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        data: {
          pair: scan.pair,
          timeframe: appState.timeframe,
          finalScore: scan.finalScore,
          trendScore: scan.trendScore,
          timingScore: scan.timingScore,
          riskScore: scan.riskScore,
          contextScore: scan.contextScore,
          mlScore: scan.mlScore,
          vectorbtScore: scan.vectorbtScore,
          signal: scan.finalScore >= 70 ? "BUY" : scan.finalScore <= 35 ? "SELL" : "WAIT"
        }
      })
    });

    if (!response.ok) {
      throw new Error(`ai ${response.status}`);
    }

    const data = await response.json();

    appState.aiDecisionCache[scan.pair] = {
      decision: sanitizeDecision(data.decision),
      title: data.title || "Décision IA",
      reason: data.reason || "Décision générée.",
      confidence: Number(data.confidence || scan.finalScore || 0),
      action: data.action || "WAIT",
      window: data.window || "intraday"
    };
  } catch {
    appState.aiDecisionCache[scan.pair] = {
      decision: scan.finalScore >= 70 ? "TRADE" : "WAIT",
      title: "Fallback IA",
      reason: "Décision locale utilisée.",
      confidence: Number(scan.finalScore || 0),
      action: scan.finalScore >= 70 ? "EXECUTE" : "WAIT",
      window: "intraday"
    };
  }

  persistState();
  renderSelectedPair();
}

export async function fetchExitSuggestion(scan, ai, targetEl) {
  if (!targetEl) return;

  try {
    const response = await fetch(API.exit, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
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
          confidence: ai?.confidence || scan.finalScore
        }
      })
    });

    if (!response.ok) {
      throw new Error(`exit ${response.status}`);
    }

    const data = await response.json();

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

export function buildJournalContextForPair() {
  return {
    pairExpectancy: 0,
    hourExpectancy: 0,
    sessionExpectancy: 0,
    pairWinRate: 0,
    hourWinRate: 0,
    sessionWinRate: 0
  };
          }
