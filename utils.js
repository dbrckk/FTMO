// ==========================
// utils.js
// ==========================
export function clamp(v, min = 1, max = 99) {
  return Math.max(min, Math.min(max, Number(v) || 0));
}

export function formatPrice(v) {
  const n = Number(v || 0);
  return n > 100 ? n.toFixed(2) : n.toFixed(5);
}

export function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

export function metricCard(label, value) {
  return `<div><b>${label}</b><br>${value}</div>`;
}
