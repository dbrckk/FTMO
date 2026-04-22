// ==========================
// chart.js
// ==========================
import { setChartInstance } from "./state.js";

export function setupChart() {
  const el = document.getElementById("chart");
  if (!el) return;

  const chart = LightweightCharts.createChart(el);
  const series = chart.addCandlestickSeries();

  setChartInstance(chart, series);
}
