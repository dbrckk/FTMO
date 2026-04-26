let chart = null;
let candleSeries = null;
let resizeObserver = null;

export function setupChart() {
  const chartContainer = document.getElementById("chart");

  if (!chartContainer) {
    return;
  }

  if (!window.LightweightCharts) {
    chartContainer.innerHTML = `
      <div class="muted" style="padding:16px;">
        Chart library unavailable.
      </div>
    `;
    return;
  }

  cleanupChart();

  chart = window.LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth || 600,
    height: Math.max(300, chartContainer.clientHeight || 340),
    layout: {
      background: {
        type: "solid",
        color: "transparent"
      },
      textColor: "#92a4bb"
    },
    grid: {
      vertLines: {
        color: "rgba(255,255,255,0.04)"
      },
      horzLines: {
        color: "rgba(255,255,255,0.04)"
      }
    },
    rightPriceScale: {
      borderColor: "rgba(255,255,255,0.08)"
    },
    timeScale: {
      borderColor: "rgba(255,255,255,0.08)",
      timeVisible: true,
      secondsVisible: false
    },
    crosshair: {
      mode: window.LightweightCharts.CrosshairMode.Normal
    }
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: "#22c55e",
    downColor: "#ef4444",
    borderUpColor: "#22c55e",
    borderDownColor: "#ef4444",
    wickUpColor: "#22c55e",
    wickDownColor: "#ef4444"
  });

  resizeObserver = new ResizeObserver(() => {
    if (!chart || !chartContainer) return;

    chart.applyOptions({
      width: chartContainer.clientWidth || 600,
      height: Math.max(300, chartContainer.clientHeight || 340)
    });
  });

  resizeObserver.observe(chartContainer);
}

export function updateChart(candles = []) {
  const chartContainer = document.getElementById("chart");

  if (!chartContainer) return;

  if (!chart || !candleSeries) {
    try {
      setupChart();
    } catch {
      return;
    }
  }

  if (!chart || !candleSeries) return;

  const data = normalizeCandles(candles);

  if (!data.length) {
    chartContainer.innerHTML = `
      <div class="muted" style="padding:16px;">
        No chart candles available.
      </div>
    `;
    cleanupChart(false);
    return;
  }

  candleSeries.setData(data);
  chart.timeScale().fitContent();
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return [];

  return candles
    .map((candle) => {
      const time = normalizeTime(candle.time ?? candle.ts ?? candle.timestamp);
      const open = Number(candle.open);
      const high = Number(candle.high);
      const low = Number(candle.low);
      const close = Number(candle.close);

      if (
        !Number.isFinite(time) ||
        !Number.isFinite(open) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close) ||
        close <= 0
      ) {
        return null;
      }

      return {
        time,
        open,
        high,
        low,
        close
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function normalizeTime(value) {
  if (typeof value === "number") {
    return value > 1000000000000 ? Math.floor(value / 1000) : Math.floor(value);
  }

  const raw = String(value || "").trim();

  if (!raw) return 0;

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1000000000000 ? Math.floor(n / 1000) : Math.floor(n);
  }

  const ms = Date.parse(raw);

  if (!Number.isFinite(ms)) return 0;

  return Math.floor(ms / 1000);
}

function cleanupChart(clearContainer = true) {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }

  if (chart) {
    chart.remove();
    chart = null;
    candleSeries = null;
  }

  if (clearContainer) {
    const chartContainer = document.getElementById("chart");
    if (chartContainer) {
      chartContainer.innerHTML = "";
    }
  }
}
