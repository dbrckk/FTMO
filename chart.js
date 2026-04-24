import { setChartInstance, chart, candleSeries } from "./state.js";

let resizeObserver = null;

export function setupChart() {
  const container = document.getElementById("chart");
  if (!container) return;

  container.innerHTML = "";

  if (!window.LightweightCharts) {
    container.innerHTML = `
      <div class="muted" style="padding:16px;">
        Chart library unavailable.
      </div>
    `;
    return;
  }

  const chartInstance = window.LightweightCharts.createChart(container, {
    width: container.clientWidth || 600,
    height: Math.max(320, Math.round((container.clientWidth || 600) * 0.48)),
    layout: {
      background: { color: "transparent" },
      textColor: "rgba(237,244,255,0.75)"
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.04)" },
      horzLines: { color: "rgba(255,255,255,0.04)" }
    },
    crosshair: {
      mode: 1
    },
    rightPriceScale: {
      borderColor: "rgba(255,255,255,0.08)"
    },
    timeScale: {
      borderColor: "rgba(255,255,255,0.08)",
      timeVisible: true,
      secondsVisible: false
    }
  });

  const series = chartInstance.addCandlestickSeries({
    upColor: "#22c55e",
    downColor: "#ef4444",
    borderUpColor: "#22c55e",
    borderDownColor: "#ef4444",
    wickUpColor: "#22c55e",
    wickDownColor: "#ef4444"
  });

  setChartInstance(chartInstance, series);

  if (resizeObserver) {
    resizeObserver.disconnect();
  }

  resizeObserver = new ResizeObserver(() => {
    if (!chartInstance || !container) return;

    chartInstance.applyOptions({
      width: container.clientWidth || 600,
      height: Math.max(320, Math.round((container.clientWidth || 600) * 0.48))
    });

    chartInstance.timeScale().fitContent();
  });

  resizeObserver.observe(container);
}

export function updateChart(candles = []) {
  const container = document.getElementById("chart");
  if (!container) return;

  if (!candleSeries || !chart) {
    setupChart();
  }

  if (!candleSeries) return;

  const data = normalizeChartCandles(candles);

  if (!data.length) {
    container.innerHTML = `
      <div class="muted" style="padding:16px;">
        Aucune donnée graphique disponible.
      </div>
    `;
    return;
  }

  candleSeries.setData(data);
  chart?.timeScale?.().fitContent?.();
}

function normalizeChartCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map((c, index) => ({
      time: normalizeTime(c.time ?? c.ts ?? c.datetime ?? index + 1),
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

function normalizeTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return Math.floor(value / 1000);
    return Math.floor(value);
  }

  const ms = Date.parse(String(value || "").trim());
  if (Number.isFinite(ms)) {
    return Math.floor(ms / 1000);
  }

  return 0;
}
