// render.js

import { appState, els } from "./state.js";
import { setText, setValue, metricCard, formatPrice } from "./utils.js";
import { computeDynamicRiskPercent, computePositionSizing } from "./trades.js";
import { updateChart } from "./chart.js";
import { fetchExitSuggestion } from "./api.js";

export function renderOverview() {
  const best = appState.scans[0];
  if (!best) return;

  const allowed = appState.scans.filter((s) => Number(s.finalScore || 0) >= 70).length;
  const blocked = appState.scans.length - allowed;

  setText("topPairLabel", best.pair);
  setText("topPairReason", best.reason || best.confluence?.label || "--");
  setText("bestScore", String(Math.round(best.finalScore || 0)));
  setText("allowedCount", String(allowed));
  setText("blockedCount", String(blocked));
  setText("globalExposure", `${appState.trades.length}`);
}

export function renderPairList(refreshAiDecision) {
  if (!els.pairList) return;
  els.pairList.innerHTML = "";

  const list = appState.scans || [];

  list.forEach((scan) => {
    const row = document.createElement("div");
    row.className = "pair-row";
    row.dataset.pair = scan.pair;

    row.innerHTML = `
      <div><strong>${scan.pair}</strong></div>
      <div>${Math.round(scan.finalScore || 0)}</div>
      <div>${Math.round(scan.mlScore || 0)}</div>
      <div>${Math.round(scan.vectorbtScore || 0)}</div>
      <div class="${(scan.finalScore || 0) >= 70 ? "ok" : "bad"}">${(scan.finalScore || 0) >= 70 ? "GO" : "WAIT"}</div>
    `;

    row.addEventListener("click", () => {
      appState.selectedPair = scan.pair;
      localStorage.setItem("ftmo-edge-ai-v4", JSON.stringify(appState));
      renderSelectedPair();
      refreshAiDecision(false, renderSelectedPair);
    });

    els.pairList.appendChild(row);
  });
}

export function renderTopPriorityTrades() {
  const wrap = document.getElementById("topPriorityTrades");
  if (!wrap) return;

  const top = [...appState.scans]
    .filter((scan) => Number(scan.finalScore || 0) >= 70)
    .sort((a, b) => Number(b.finalScore || 0) - Number(a.finalScore || 0))
    .slice(0, 5);

  wrap.innerHTML = top.length
    ? top.map((scan) => `
      <div class="top-row">
        <strong>${scan.pair}</strong> - ${Math.round(scan.finalScore || 0)} - ${scan.signal}
      </div>
    `).join("")
    : `<div class="muted">Aucun trade prioritaire.</div>`;
}

export function renderTopBlockedTrades() {
  const wrap = document.getElementById("topBlockedTrades");
  if (!wrap) return;

  const blocked = [...appState.scans]
    .filter((scan) => Number(scan.finalScore || 0) < 55)
    .sort((a, b) => Number(a.finalScore || 0) - Number(b.finalScore || 0))
    .slice(0, 5);

  wrap.innerHTML = blocked.length
    ? blocked.map((scan) => `
      <div class="top-row blocked">
        <strong>${scan.pair}</strong> - ${Math.round(scan.finalScore || 0)}
      </div>
    `).join("")
    : `<div class="muted">Aucun trade bloqué majeur.</div>`;
}

export function renderCorrelationMatrix() {
  if (!els.correlationSummary || !els.correlationMatrixBox) return;

  const data = appState.correlationMatrix;
  if (!data || !Array.isArray(data.pairs) || !Array.isArray(data.matrix)) {
    els.correlationSummary.innerHTML = "Correlation matrix unavailable.";
    els.correlationMatrixBox.innerHTML = `<div class="muted">Aucune donnée.</div>`;
    return;
  }

  const alerts = [];
  for (let i = 0; i < data.pairs.length; i += 1) {
    for (let j = i + 1; j < data.pairs.length; j += 1) {
      const corr = Number(data.matrix[i][j] || 0);
      if (Math.abs(corr) >= 0.8) {
        alerts.push(`${data.pairs[i]} / ${data.pairs[j]} : ${corr.toFixed(2)}`);
      }
    }
  }

  els.correlationSummary.innerHTML = alerts.length
    ? `<strong>High correlation pairs detected:</strong><br>${alerts.slice(0, 6).join("<br>")}`
    : `No major correlation concentration detected.`;

  els.correlationMatrixBox.innerHTML = `
    <div style="overflow:auto;">
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left; padding:8px;">Pair</th>
            ${data.pairs.map((pair) => `<th style="padding:8px;">${pair}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${data.pairs.map((rowPair, i) => `
            <tr>
              <td style="padding:8px; font-weight:700;">${rowPair}</td>
              ${data.matrix[i].map((value, j) => {
                const corr = Number(value || 0);
                const bg =
                  i === j ? "rgba(255,255,255,0.08)" :
                  Math.abs(corr) >= 0.8 ? "rgba(255,102,127,0.18)" :
                  Math.abs(corr) >= 0.6 ? "rgba(255,193,77,0.14)" :
                  "rgba(255,255,255,0.03)";
                return `<td style="padding:8px; text-align:center; background:${bg};">${corr.toFixed(2)}</td>`;
              }).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

export function renderSelectedPair() {
  const pair = appState.selectedPair;
  if (!pair) return;

  const scan = appState.scans.find((s) => s.pair === pair);
  if (!scan) return;

  const ai = appState.aiDecisionCache?.[pair] || {
    decision: "WAIT",
    title: "Décision en attente",
    reason: "Aucune décision IA disponible."
  };

  setText("selectedPairName", scan.pair);
  setText("trendMini", Math.round(scan.trendScore || 0));
  setText("confidenceMini", `${Math.round(scan.finalScore || 0)}%`);
  setText("rrMini", scan.rr || "-");
  setText("aiMini", ai.decision || "-");

  setText("decisionBadge", ai.decision || "WAIT");
  setText("decisionText", ai.title || "Décision IA");
  setText("decisionReason", ai.reason || "-");
  setText("decisionAsset", scan.pair);
  setText("decisionConfidence", `${Math.round(ai.confidence || scan.finalScore || 0)}%`);
  setText("decisionAction", ai.action || (scan.finalScore >= 70 ? "EXECUTE" : "WAIT"));
  setText("decisionWindow", ai.window || "Intraday");

  if (els.summaryMetrics) {
    els.summaryMetrics.innerHTML = [
      metricCard("Prix", formatPrice(scan.current), "marché"),
      metricCard("Final", Math.round(scan.finalScore || 0), "global"),
      metricCard("Trend", Math.round(scan.trendScore || 0), "direction"),
      metricCard("Timing", Math.round(scan.timingScore || 0), "timing"),
      metricCard("Risk", Math.round(scan.riskScore || 0), "risk"),
      metricCard("Context", Math.round(scan.contextScore || 0), "context"),
      metricCard("ML", Math.round(scan.mlScore || 0), scan.mlConfidenceBand || "model"),
      metricCard("VBT", Math.round(scan.vectorbtScore || 0), scan.vectorbtConfidenceBand || "backtest")
    ].join("");
  }

  const reasonList = document.getElementById("reasonList");
  if (reasonList) {
    reasonList.innerHTML = "";
    (scan.reasons || []).forEach((reason) => {
      const li = document.createElement("li");
      li.textContent = reason;
      reasonList.appendChild(li);
    });
  }

  const riskPct = computeDynamicRiskPercent(scan);
  const sizing = computePositionSizing(
    scan,
    Number(document.getElementById("tradeCapital")?.value || appState.ftmo.accountSize || 10000)
  );

  if (els.tradeSuggestionBox) {
    els.tradeSuggestionBox.innerHTML = `
      <strong>${ai.decision || scan.signal || "WAIT"}</strong><br>
      Entry: ${formatPrice(scan.current)}<br>
      Stop: ${formatPrice(scan.stopLoss || scan.current * 0.995)}<br>
      Target: ${formatPrice(scan.takeProfit || scan.current * 1.01)}<br>
      ML: ${Math.round(scan.mlScore || 0)}<br>
      VectorBT: ${Math.round(scan.vectorbtScore || 0)}<br>
      Risk conseillé: ${riskPct}%<br>
      Position size: ${sizing.quantity}<br>
      Profile: ${sizing.leverageLabel}<br>
      Motif: ${ai.reason || scan.reason || "-"}
    `;
  }

  if (els.exitSuggestionBox) {
    els.exitSuggestionBox.innerHTML = `
      Exit logic: HOLD<br>
      Exit score: 50<br>
      Comment: No exit signal
    `;
  }

  updateChart(scan.candles || []);
  fetchExitSuggestion(scan, ai, els.exitSuggestionBox);

  setValue("tradePair", scan.pair);
  setValue("tradeDirection", scan.signal === "SELL" ? "sell" : "buy");
  setValue("tradeEntry", Number(scan.current || 0).toFixed(5));
  setValue("riskPercent", String(riskPct));
}

export function renderTrades() {
  const tradeList = document.getElementById("tradeList");
  const tradeStats = document.getElementById("tradeStats");
  if (!tradeList) return;

  tradeList.innerHTML = "";

  appState.trades.forEach((trade) => {
    const row = document.createElement("div");
    row.className = "trade-row";
    row.innerHTML = `
      <div><strong>${trade.pair}</strong></div>
      <div>${trade.direction}</div>
      <div>${trade.riskPercent}%</div>
      <div>${Number(trade.entry || 0).toFixed(5)}</div>
      <div>${trade.status}</div>
    `;
    tradeList.appendChild(row);
  });

  if (tradeStats) tradeStats.textContent = String(appState.trades.length);
}

export function renderWatchlist() {
  const watch = document.getElementById("watchlist");
  const count = document.getElementById("watchlistCount");
  if (!watch) return;

  watch.innerHTML = "";
  appState.watchlist.forEach((pair) => {
    const div = document.createElement("div");
    div.className = "watch-item";
    div.textContent = pair;
    watch.appendChild(div);
  });

  if (count) count.textContent = String(appState.watchlist.length);
}

export function renderFtmoRisk() {
  const ftmo = appState.ftmo || {};
  const accountSize = Number(ftmo.accountSize || 10000);
  const requested = Number(ftmo.requestedRiskPercent || 1);
  const dailyLimitPercent = Number(ftmo.dailyLossLimitPercent || 5);
  const closedTodayPnl = Number(ftmo.closedTodayPnl || 0);

  const remainingDaily =
    (accountSize * dailyLimitPercent / 100) -
    Math.abs(closedTodayPnl);

  const maxRisk = remainingDaily > 0
    ? (remainingDaily / accountSize) * 100
    : 0;

  setText("ftmoDailyRemaining", `${remainingDaily.toFixed(2)}$`);
  setText("ftmoMaxAdditionalRisk", `${maxRisk.toFixed(2)}%`);
  setText("ftmoDecisionText", maxRisk >= requested ? "ALLOWED" : "BLOCKED");
  setText(
    "ftmoDecisionReason",
    maxRisk >= requested
      ? "Risque encore autorisé."
      : "Le risque demandé dépasse la marge disponible."
  );

  const badge = document.getElementById("ftmoDecisionBadge");
  if (badge) badge.textContent = maxRisk >= requested ? "OK" : "BLOCK";
             }
