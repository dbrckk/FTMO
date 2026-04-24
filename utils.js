export function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function sanitizeDecision(value) {
  const v = String(value || "").trim().toUpperCase();

  if (["TRADE", "BUY", "SELL", "EXECUTE", "GO"].includes(v)) return "TRADE";
  if (["NO TRADE", "BLOCK", "BLOCKED", "AVOID"].includes(v)) return "NO TRADE";
  if (["WAIT", "HOLD", "NEUTRAL"].includes(v)) return "WAIT";

  return v || "WAIT";
}

export function normalizeCandles(candles = []) {
  return candles
    .map((c, index) => ({
      time: normalizeCandleTime(c.time ?? c.ts ?? c.datetime ?? index + 1),
      open: Number(c.open || 0),
      high: Number(c.high || 0),
      low: Number(c.low || 0),
      close: Number(c.close || 0)
    }))
    .filter((c) =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.time > 0
    )
    .sort((a, b) => a.time - b.time);
}

export function normalizeCandleTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return Math.floor(value / 1000);
    return Math.floor(value);
  }

  const parsed = Date.parse(String(value).trim());
  if (Number.isFinite(parsed)) {
    return Math.floor(parsed / 1000);
  }

  return 0;
}

export function setText(id, value) {
  const el = typeof id === "string" ? document.getElementById(id) : id;
  if (!el) return;
  el.textContent = value == null ? "" : String(value);
}

export function setHTML(id, value) {
  const el = typeof id === "string" ? document.getElementById(id) : id;
  if (!el) return;
  el.innerHTML = value == null ? "" : String(value);
}

export function setValue(id, value) {
  const el = typeof id === "string" ? document.getElementById(id) : id;
  if (!el) return;
  el.value = value == null ? "" : String(value);
}

export function formatPrice(value, pair = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";

  if (pair === "XAUUSD") return n.toFixed(2);
  if (String(pair).includes("JPY")) return n.toFixed(3);
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  return n.toFixed(5);
}

export function formatPercent(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(digits)}%`;
}

export function formatNumber(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(digits);
}

export function metricCard(label, value, hint = "") {
  return `
    <div class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(String(value))}</div>
      <div class="metric-hint">${escapeHtml(String(hint || ""))}</div>
    </div>
  `;
}

export function uid(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function sum(values = []) {
  return safeArray(values).reduce((acc, v) => acc + Number(v || 0), 0);
}

export function average(values = [], fallback = 0) {
  const arr = safeArray(values).map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (!arr.length) return fallback;
  return sum(arr) / arr.length;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
            }
