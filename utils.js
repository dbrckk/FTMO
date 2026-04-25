export function clamp(value, min = 0, max = 100) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return min;
  }

  return Math.max(min, Math.min(max, n));
}

export function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  return Number(n.toFixed(digits));
}

export function formatPrice(value, pair = "") {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return "-";
  }

  const p = String(pair || "").toUpperCase();

  if (p === "XAUUSD") {
    return n.toFixed(2);
  }

  if (p === "BTCUSD") {
    return n.toFixed(2);
  }

  if (p.includes("JPY")) {
    return n.toFixed(3);
  }

  return n.toFixed(5);
}

export function setText(id, value) {
  const el = document.getElementById(id);

  if (!el) return;

  el.textContent = value ?? "";
}

export function setValue(id, value) {
  const el = document.getElementById(id);

  if (!el) return;

  el.value = value ?? "";
}

export function metricCard(label, value, hint = "") {
  return `
    <div class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
      <div class="metric-hint">${escapeHtml(hint)}</div>
    </div>
  `;
}

export function sanitizeDecision(value) {
  const raw = String(value || "").trim().toUpperCase();

  if (
    raw === "TRADE" ||
    raw === "BUY" ||
    raw === "SELL" ||
    raw === "WAIT" ||
    raw === "NO TRADE" ||
    raw === "BLOCKED"
  ) {
    return raw;
  }

  if (raw.includes("BUY")) return "BUY";
  if (raw.includes("SELL")) return "SELL";
  if (raw.includes("TRADE")) return "TRADE";
  if (raw.includes("BLOCK")) return "BLOCKED";

  return "WAIT";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

export function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

export function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);

  if (!nums.length) return 0;

  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

export function nowIso() {
  return new Date().toISOString();
  }
