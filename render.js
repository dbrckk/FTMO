// ==========================
// render.js
// ==========================
import { appState } from "./state.js";

export function renderPairList() {
  const el = document.getElementById("pairList");
  if (!el) return;

  el.innerHTML = appState.scans.map(s => `
    <div>${s.pair} - ${Math.round(s.finalScore)}</div>
  `).join("");
}
