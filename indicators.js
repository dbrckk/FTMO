// indicators.js

export function emaSeries(values, period) {
  const out = [];
  if (!Array.isArray(values) || !values.length) return out;

  const k = 2 / (period + 1);
  let prev = Number(values[0] || 0);

  values.forEach((value, index) => {
    const n = Number(value || 0);
    prev = index === 0 ? n : n * k + prev * (1 - k);
    out.push(prev);
  });

  return out;
}

export function computeMomentum(closes, lookback = 12) {
  if (!Array.isArray(closes) || closes.length <= lookback) return 0;

  const past = Number(closes[closes.length - lookback - 1] || 0);
  const current = Number(closes.at(-1) || 0);

  if (!past) return 0;

  return ((current - past) / past) * 100;
}

export function rsi(values, period = 14) {
  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = Number(values[i] || 0) - Number(values[i - 1] || 0);

    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

export function atr(highs, lows, closes, period = 14) {
  const trs = [];

  for (let i = 1; i < highs.length; i++) {
    const high = Number(highs[i] || 0);
    const low = Number(lows[i] || 0);
    const prevClose = Number(closes[i - 1] || 0);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trs.push(tr);
  }

  const recent = trs.slice(-period);

  return recent.length
    ? recent.reduce((a, b) => a + b, 0) / recent.length
    : 0;
}

export function macd(values) {
  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);

  const macdLine = ema12.map((v, i) => v - (ema26[i] || 0));
  const signal = emaSeries(macdLine, 9);

  return {
    macdLine: macdLine.at(-1) || 0,
    signal: signal.at(-1) || 0
  };
}

export function volatility(closes, period = 20) {
  if (closes.length < period) return 0;

  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;

  const variance =
    slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
    period;

  return Math.sqrt(variance);
}

export function trendStrength(ema20, ema50) {
  const diff = ema20 - ema50;

  if (Math.abs(diff) < 0.0001) return 50;

  return diff > 0 ? 70 : 30;
                                                 }
