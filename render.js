import { appState, els, persistState } from "./state.js";
import { setText, setValue, metricCard, formatPrice } from "./utils.js";
import { computeDynamicRiskPercent, computePositionSizing } from "./trades.js";
import { updateChart } from "./chart.js";
import { fetchExitSuggestion } from "./api.js";
import { computePaperAnalytics } from "./paper-engine.js";

export function setActiveTab(tabName) {
  appState.activeTab = tabName;
  persistState();
}

export function renderTabs() {
  const dashboard = document.getElementById("dashboardTab");
  const paper = document.getElementById("paperTab");
  const btnDashboard = document.getElementById("tabDashboardBtn");
  const btnPaper = document.getElementById("tabPaperBtn");

  const active = appState.activeTab || "dashboard";

  if (dashboard) dashboard.style.display = active === "dashboard" ? "" : "none";
  if (paper) paper.style.display = active === "paper" ? "" : "none";

  if (btnDashboard) btnDashboard.classList.toggle("active-tab", active === "dashboard");
  if (btnPaper) btnPaper.classList.toggle("active-tab", active === "paper");
}

export function renderOverview() {
  const bestAllowed = [...(appState.scans || [])]
    .filter((scan) => scan.tradeAllowed)
    .sort((a, b) => Number(b.ultraScore || b.finalScore || 0) - Number(a.ultraScore || a.finalScore || 0))[0];

  const bestBlocked = [...(appState.scans || [])]
    .filter((scan) => !scan.tradeAllowed)
    .sort((a, b) => Number(b.ultraScore || b.finalScore || 0) - Number(a.ultraScore || a.finalScore || 0))[0];

  const best = bestAllowed || bestBlocked;

  const allowed = (appState.scans || []).filter((s) => s.tradeAllowed).length;
  const blocked = (appState.scans || []).length - allowed;

  setText("topPairLabel", best?.pair || "-");
  setText("topPairReason", best?.tradeReason || best?.reason || best?.confluence?.label || "Aucune analyse disponible.");
  setText("bestScore", best ? String(Math.round(best.ultraScore || best.finalScore || 0)) : "-");
  setText("allowedCount", String(allowed));
  setText("blockedCount", String(blocked));
  setText("globalExposure", String((appState.trades || []).length));
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
      <div><strong>${esc(scan.pair)}</strong></div>
      <div>${Math.round(scan.ultraScore || scan.finalScore || 0)}</div>
      <div>${Math.round(scan.mlScore || 0)}</div>
      <div>${Math.round(scan.vectorbtScore || 0)}</div>
      <div class="${scan.tradeAllowed ? "ok" : "bad"}">${esc(scan.tradeStatus || "WAIT")}</div>
    `;

    row.addEventListener("click", () => {
      appState.selectedPair = scan.pair;
      persistState();
      renderSelectedPair();

      if (typeof refreshAiDecision === "function") {
        refreshAiDecision(false, renderSelectedPair);
      }
    });

    els.pairList.appendChild(row);
  });
}

export function renderTopPriorityTrades() {
  const wrap = document.getElementById("topPriorityTrades");
  if (!wrap) return;

  const top = [...(appState.scans || [])]
    .filter((scan) => scan.tradeAllowed && Number(scan.ultraScore || 0) >= 68)
    .sort((a, b) => Number(b.ultraScore || 0) - Number(a.ultraScore || 0))
    .slice(0, 6);

  wrap.innerHTML = top.length
    ? top.map((scan) => `
      <div class="top-row">
        <strong>${esc(scan.pair)}</strong>
        <span>ULTRA ${Math.round(scan.ultraScore || 0)}</span>
        <span>${esc(scan.tradeStatus || "VALID")}</span>
      </div>
    `).join("")
    : `<div class="muted">Aucun trade premium.</div>`;
}

export function renderTopBlockedTrades() {
  const wrap = document.getElementById("topBlockedTrades");
  if (!wrap) return;

  const blocked = [...(appState.scans || [])]
    .filter((scan) => !scan.tradeAllowed)
    .sort((a, b) => Number(b.ultraScore || b.finalScore || 0) - Number(a.ultraScore || a.finalScore || 0))
    .slice(0, 6);

  wrap.innerHTML = blocked.length
    ? blocked.map((scan) => `
      <div class="top-row blocked">
        <strong>${esc(scan.pair)}</strong>
        <span>ULTRA ${Math.round(scan.ultraScore || scan.finalScore || 0)}</span>
        <span>${esc(scan.tradeReason || "Blocked")}</span>
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
    ? `<strong>High correlation pairs detected:</strong><br>${alerts.slice(0, 8).map(esc).join("<br>")}`
    : `No major correlation concentration detected.`;

  els.correlationMatrixBox.innerHTML = `
    <div style="overflow:auto;">
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left; padding:8px;">Pair</th>
            ${data.pairs.map((pair) => `<th style="padding:8px;">${esc(pair)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${data.pairs.map((rowPair, i) => `
            <tr>
              <td style="padding:8px; font-weight:700;">${esc(rowPair)}</td>
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

  const scan = (appState.scans || []).find((s) => s.pair === pair);
  if (!scan) return;

  const ai = appState.aiDecisionCache?.[pair] || {
    decision: "WAIT",
    title: "Décision en attente",
    reason: "Aucune décision IA disponible."
  };

  setText("selectedPairName", scan.pair);
  setText("trendMini", Math.round(scan.trendScore || 0));
  setText("confidenceMini", `${Math.round(scan.ultraScore || scan.finalScore || 0)}%`);
  setText("rrMini", scan.rr || "-");
  setText("aiMini", ai.decision || "-");

  setText("decisionBadge", scan.tradeStatus || ai.decision || "WAIT");
  setText("decisionText", ai.title || "Décision IA");
  setText("decisionReason", scan.tradeReason || ai.reason || "-");
  setText("decisionAsset", scan.pair);
  setText("decisionConfidence", `${Math.round(ai.confidence || scan.ultraScore || scan.finalScore || 0)}%`);
  setText("decisionAction", ai.action || (scan.tradeAllowed ? "EXECUTE" : "WAIT"));
  setText("decisionWindow", ai.window || "Intraday");
  setText("decisionActionMirror", ai.action || (scan.tradeAllowed ? "EXECUTE" : "WAIT"));

  if (els.summaryMetrics) {
    els.summaryMetrics.innerHTML = [
      metricCard("Prix", formatPrice(scan.current, scan.pair), "marché"),
      metricCard("Final", Math.round(scan.finalScore || 0), "global"),
      metricCard("ULTRA", Math.round(scan.ultraScore || 0), scan.ultraGrade || "-"),
      metricCard("Trend", Math.round(scan.trendScore || 0), "direction"),
      metricCard("Timing", Math.round(scan.timingScore || 0), "timing"),
      metricCard("Risk", Math.round(scan.riskScore || 0), "risk"),
      metricCard("Smart", Math.round(scan.smartMoneyScore || 0), "flow"),
      metricCard("Exec", Math.round(scan.executionScore || 0), "execution"),
      metricCard("Archive", Math.round(scan.archiveEdgeScore || 0), "archive"),
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
    Number(document.getElementById("tradeCapital")?.value || appState.ftmo?.accountSize || 10000)
  );

  if (els.tradeSuggestionBox) {
    els.tradeSuggestionBox.innerHTML = `
      <strong>${esc(scan.tradeStatus || ai.decision || scan.signal || "WAIT")}</strong><br>
      Ultra Score: ${Math.round(scan.ultraScore || 0)} (${esc(scan.ultraGrade || "-")})<br>
      Entry: ${formatPrice(scan.current, scan.pair)}<br>
      Stop: ${formatPrice(scan.stopLoss || scan.current * 0.995, scan.pair)}<br>
      Target: ${formatPrice(scan.takeProfit || scan.current * 1.01, scan.pair)}<br>
      ML: ${Math.round(scan.mlScore || 0)}<br>
      VectorBT: ${Math.round(scan.vectorbtScore || 0)}<br>
      Smart Money: ${Math.round(scan.smartMoneyScore || 0)}<br>
      Session: ${Math.round(scan.sessionScore || 0)}<br>
      Execution: ${Math.round(scan.executionScore || 0)}<br>
      Archive Edge: ${Math.round(scan.archiveEdgeScore || 0)}<br>
      Archive WR: ${Math.round(scan.archiveStats?.pairWinRate || 50)}%<br>
      Archive Expectancy: ${(Number(scan.archiveStats?.pairExpectancy || 0)).toFixed(2)}R<br>
      Same Direction WR: ${Math.round(scan.archiveStats?.sameDirectionWinRate || 50)}%<br>
      Same Direction Exp: ${(Number(scan.archiveStats?.sameDirectionExpectancy || 0)).toFixed(2)}R<br>
      Risk conseillé: ${riskPct}%<br>
      Position size: ${sizing.quantity}<br>
      Profile: ${esc(sizing.leverageLabel)}<br>
      Motif: ${esc(scan.tradeReason || ai.reason || scan.reason || "-")}
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
  setValue("tradeEntry", Number(scan.current || 0).toFixed(scan.pair === "XAUUSD" ? 2 : scan.pair.includes("JPY") ? 3 : 5));
  setValue("riskPercent", String(riskPct));
}

export function renderTrades() {
  const tradeList = document.getElementById("tradeList");
  const tradeStats = document.getElementById("tradeStats");

  if (!tradeList) return;

  tradeList.innerHTML = "";

  (appState.trades || []).forEach((trade) => {
    const row = document.createElement("div");
    row.className = "trade-row";
    row.innerHTML = `
      <div><strong>${esc(trade.pair)}</strong></div>
      <div>${esc(trade.direction)}</div>
      <div>${Number(trade.riskPercent || 0)}%</div>
      <div>${formatPrice(trade.entry, trade.pair)}</div>
      <div>${esc(trade.status)}</div>
    `;

    tradeList.appendChild(row);
  });

  if (tradeStats) tradeStats.textContent = String((appState.trades || []).length);
}

export function renderWatchlist() {
  const watch = document.getElementById("watchlist");
  const count = document.getElementById("watchlistCount");

  if (!watch) return;

  watch.innerHTML = "";

  (appState.watchlist || []).forEach((pair) => {
    const div = document.createElement("div");
    div.className = "watch-item";
    div.textContent = pair;
    watch.appendChild(div);
  });

  if (count) count.textContent = String((appState.watchlist || []).length);
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

  const text = maxRisk >= requested ? "ALLOWED" : "BLOCKED";
  const reason = maxRisk >= requested
    ? "Risque encore autorisé."
    : "Le risque demandé dépasse la marge disponible.";

  setText("ftmoDailyRemaining", `${remainingDaily.toFixed(2)}$`);
  setText("ftmoMaxAdditionalRisk", `${maxRisk.toFixed(2)}%`);
  setText("ftmoDecisionText", text);
  setText("ftmoDecisionReason", reason);
  setText("ftmoDecisionTextSecondary", text);
  setText("ftmoDecisionReasonSecondary", reason);

  const badge = document.getElementById("ftmoDecisionBadge");
  if (badge) badge.textContent = maxRisk >= requested ? "OK" : "BLOCK";
}

export function renderPaperLab() {
  const localAnalytics = computePaperAnalytics();
  const server = appState.serverPaperSnapshot || null;

  const serverOpen = Array.isArray(server?.open) ? server.open : [];
  const serverRecent = Array.isArray(server?.recent) ? server.recent : [];
  const serverPairStats = Array.isArray(server?.pairStats) ? server.pairStats : [];
  const serverRuns = Array.isArray(server?.runs) ? server.runs : [];
  const serverSummary = server?.summary || null;

  const openCount = serverOpen.length || localAnalytics.openTradesCount || 0;
  const closedCount = Number(serverSummary?.trades ?? localAnalytics.totalClosedTrades ?? 0);
  const winRate = Number(serverSummary?.winRate ?? localAnalytics.winRate ?? 0);
  const expectancy = Number(serverSummary?.expectancy ?? localAnalytics.expectancy ?? 0);
  const netPnl = Number(serverSummary?.pnl ?? localAnalytics.netPnl ?? 0);

  const status = document.getElementById("paperEngineStatus");
  const openBox = document.getElementById("paperOpenTrades");
  const statsBox = document.getElementById("paperStats");
  const pairBox = document.getElementById("paperPairStats");
  const recentBox = document.getElementById("paperRecentTrades");
  const toggleBtn = document.getElementById("paperEngineToggleBtn");
  const paperOpenKpi = document.getElementById("paperOpenKpi");
  const runsBox = document.getElementById("paperServerRuns");

  if (toggleBtn) {
    toggleBtn.textContent = appState.paperEngine?.enabled ? "Browser Paper ON" : "Browser Paper OFF";
  }

  if (paperOpenKpi) {
    paperOpenKpi.textContent = String(openCount);
  }

  if (status) {
    const lastRun = serverRuns[0];

    status.innerHTML = `
      <strong>Status:</strong> Server + Browser<br>
      Server open trades: ${serverOpen.length}<br>
      Server closed trades: ${closedCount}<br>
      Browser open trades: ${localAnalytics.openTradesCount}<br>
      Browser closed trades: ${localAnalytics.totalClosedTrades}<br>
      Win rate: ${winRate.toFixed(1)}%<br>
      Expectancy: ${expectancy.toFixed(3)}R<br>
      Net PnL: ${netPnl.toFixed(2)}$<br>
      Last server run: ${lastRun ? esc(formatDateShort(lastRun.ranAt)) : "-"}<br>
      Last run opened/closed: ${lastRun ? `${Number(lastRun.opened || 0)} / ${Number(lastRun.closed || 0)}` : "-"}
    `;
  }

  if (openBox) {
    if (serverOpen.length) {
      openBox.innerHTML = serverOpen.map((trade) => `
        <div class="top-row">
          <strong>${esc(trade.pair)}</strong>
          <span>${esc(trade.direction)}</span>
          <span>ULTRA ${Math.round(trade.ultraScore || 0)}</span>
          <span>${Number(trade.pnlRLive || 0).toFixed(2)}R live</span>
          <span>${Number(trade.barsHeld || 0)} bars</span>
        </div>
      `).join("");
    } else if ((appState.paperTrades || []).length) {
      openBox.innerHTML = (appState.paperTrades || []).map((trade) => `
        <div class="top-row">
          <strong>${esc(trade.pair)}</strong>
          <span>${esc(trade.direction)}</span>
          <span>${Number(trade.entryUltraScore || 0)}</span>
          <span>${Number(trade.barsHeld || 0)} bars</span>
        </div>
      `).join("");
    } else {
      openBox.innerHTML = `<div class="muted">No open paper trades.</div>`;
    }
  }

  if (statsBox) {
    statsBox.innerHTML = `
      <div class="metric-card">
        <div class="metric-label">Closed</div>
        <div class="metric-value">${closedCount}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Win rate</div>
        <div class="metric-value">${winRate.toFixed(1)}%</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Expectancy</div>
        <div class="metric-value">${expectancy.toFixed(3)}R</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Net PnL</div>
        <div class="metric-value">${netPnl.toFixed(2)}$</div>
      </div>
    `;
  }

  if (pairBox) {
    const pairRows = serverPairStats.length ? serverPairStats : localAnalytics.pairStats || [];

    pairBox.innerHTML = pairRows.length
      ? pairRows.map((row) => `
        <div class="top-row">
          <strong>${esc(row.pair)}</strong>
          <span>${Number(row.trades || 0)} trades</span>
          <span>${Number(row.winRate || 0).toFixed(1)}%</span>
          <span>${Number(row.expectancy || 0).toFixed(3)}R</span>
        </div>
      `).join("")
      : `<div class="muted">No archived pair stats yet.</div>`;
  }

  if (recentBox) {
    const recentRows = serverRecent.length ? serverRecent : localAnalytics.recentTrades || [];

    recentBox.innerHTML = recentRows.length
      ? recentRows.map((trade) => `
        <div class="top-row ${Number(trade.pnlR || 0) > 0 ? "ok" : "blocked"}">
          <strong>${esc(trade.pair)}</strong>
          <span>${esc(trade.direction)}</span>
          <span>${Number(trade.pnlR || 0).toFixed(2)}R</span>
          <span>${esc(trade.closeReason || trade.close_reason || "-")}</span>
        </div>
      `).join("")
      : `<div class="muted">No recent paper trades.</div>`;
  }

  if (runsBox) {
    runsBox.innerHTML = serverRuns.length
      ? serverRuns.map((run) => `
        <div class="top-row">
          <strong>${esc(formatDateShort(run.ranAt))}</strong>
          <span>${Number(run.scannedPairs || 0)} scanned</span>
          <span>+${Number(run.opened || 0)} / -${Number(run.closed || 0)}</span>
        </div>
      `).join("")
      : `<div class="muted">No server run yet.</div>`;
  }
}

export function renderPaperHealth() {
  const box = document.getElementById("paperHealthBox");
  if (!box) return;

  const health = appState.paperHealth;

  if (!health || !health.ok) {
    box.innerHTML = `<div class="muted">Paper health unavailable.</div>`;
    return;
  }

  const statusClass =
    health.status === "HEALTHY"
      ? "ok"
      : health.status === "WARNING"
        ? "warning"
        : "bad";

  const market = health.market || {};
  const paper = health.paper || {};
  const lastRun = paper.lastRun || null;

  box.innerHTML = `
    <div class="top-row">
      <strong class="${statusClass}">${esc(health.status || "UNKNOWN")}</strong>
      <span>${Number(market.freshPairs || 0)} fresh</span>
      <span>${Number(market.stalePairs || 0)} stale</span>
      <span>${Number(market.missingPairs || 0)} missing</span>
    </div>

    <div class="top-row">
      <strong>Server paper</strong>
      <span>${Number(paper.openTrades || 0)} open</span>
      <span>${Number(paper.closedTrades || 0)} closed</span>
      <span>${Number(paper.winRate || 0).toFixed(1)}% WR</span>
    </div>

    <div class="top-row">
      <strong>Last run</strong>
      <span>${lastRun ? esc(formatDateShort(lastRun.ranAt)) : "-"}</span>
      <span>+${lastRun ? Number(lastRun.opened || 0) : 0}</span>
      <span>-${lastRun ? Number(lastRun.closed || 0) : 0}</span>
    </div>
  `;
}

function formatDateShort(value) {
  if (!value) return "-";

  try {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleString("fr-FR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return String(value);
  }
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
