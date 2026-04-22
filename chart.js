// chart.js

import { setChartInstance, chart, candleSeries } from "./state.js";

export function setupChart() {
  const el = document.getElementById("chart");
  if (!el || typeof LightweightCharts === "undefined") return;

  const nextChart = LightweightCharts.createChart(el, {
    width: el.clientWidth || 600,
    height: 320,
    layout: {
      background: { color: "#0b0b0b" },
      textColor: "#ffffff"
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.05)" },
      horzLines: { color: "rgba(255,255,255,0.05)" }
    }
  });

  const nextCandleSeries = nextChart.addCandlestickSeries({
    upColor: "#22c55e",
    downColor: "#ef4444",
    wickUpColor: "#22c55e",
    wickDownColor: "#ef4444",
    borderVisible: false
  });

  setChartInstance(nextChart, nextCandleSeries);
}

export function updateChart(candles) {
  if (!candleSeries || !Array.isArray(candles) || !candles.length) return;

  candleSeries.setData(
    candles.map((c, i) => ({
      time: c.time || i + 1,
      open: Number(c.open || 0),
      high: Number(c.high || 0),
      low: Number(c.low || 0),
      close: Number(c.close || 0)
    }))
  );

  chart?.timeScale().fitContent();
}
