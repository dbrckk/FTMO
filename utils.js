// utils.js

export function clamp(v, min = 1, max = 99) {
  return Math.max(min, Math.min(max, Number(v) || 0));
}

export function sanitizeDecision(value) {
  const v = String(value || "").toUpperCase();

  if (v.includes("NO")) return "NO TRADE";
  if (v.includes("WAIT")) return "WAIT";
  if (v.includes("BUY")) return "BUY";
  if (v.includes("SELL")) return "SELL";

  return "WAIT";
}

export function formatPrice(v) {
  const n = Number(v || 0);
  return n > 100 ? n.toFixed(2) : n.toFixed(5);
}

export function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

export function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

export function metricCard(label, value, hint = "") {
  return `
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
      <div class="metric-hint">${hint}</div>
    </div>
  `;
}

export function signalClass(value) {
  const v = String(value || "").toUpperCase();

  if (v.includes("BUY")) return "ok";
  if (v.includes("SELL")) return "bad";
  if (v.includes("NO")) return "bad";

  return "neutral";
}

export function normalizeCandles(candles) {
  return candles.map((c, i) => ({
    time: c.time || i + 1,
    open: Number(c.open || 0),
    high: Number(c.high || 0),
    low: Number(c.low || 0),
    close: Number(c.close || 0)
  }));
}

export function debounce(fn, delay = 300) {
  let timeout;

  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

export function throttle(fn, limit = 1000) {
  let lastCall = 0;

  return (...args) => {
    const now = Date.now();

    if (now - lastCall >= limit) {
      lastCall = now;
      fn(...args);
    }
  };
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

export function percent(value, total) {
  if (!total) return 0;
  return (value / total) * 100;
}
