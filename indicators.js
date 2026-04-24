export function emaSeries(values = [], period = 20) {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));

  if (!nums.length) return [];

  const k = 2 / (period + 1);
  const out = [];
  let prev = nums[0];

  for (let i = 0; i < nums.length; i += 1) {
    if (i === 0) {
      prev = nums[i];
    } else {
      prev = nums[i] * k + prev * (1 - k);
    }

    out.push(prev);
  }

  return out;
}

export function smaSeries(values = [], period = 20) {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));

  if (!nums.length) return [];

  const out = [];

  for (let i = 0; i < nums.length; i += 1) {
    const start = Math.max(0, i - period + 1);
    const slice = nums.slice(start, i + 1);
    const avg = slice.reduce((sum, v) => sum + v, 0) / slice.length;
    out.push(avg);
  }

  return out;
}

export function rsi(values = [], period = 14) {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));

  if (nums.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  const start = Math.max(1, nums.length - period);

  for (let i = start; i < nums.length; i += 1) {
    const diff = nums[i] - nums[i - 1];

    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0 && gains === 0) return 50;
  if (losses === 0) return 100;

  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

export function atr(highs = [], lows = [], closes = [], period = 14) {
  const h = highs.map(Number);
  const l = lows.map(Number);
  const c = closes.map(Number);

  if (h.length < 2 || l.length < 2 || c.length < 2) return 0;

  const trs = [];

  for (let i = 1; i < h.length; i += 1) {
    const high = h[i];
    const low = l[i];
    const prevClose = c[i - 1];

    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(prevClose)
    ) {
      continue;
    }

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trs.push(tr);
  }

  const recent = trs.slice(-period);
  if (!recent.length) return 0;

  return recent.reduce((sum, v) => sum + v, 0) / recent.length;
}

export function computeMomentum(values = [], lookback = 12) {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));

  if (nums.length <= lookback) return 0;

  const current = nums.at(-1);
  const past = nums.at(-1 - lookback);

  if (!Number.isFinite(current) || !Number.isFinite(past) || past === 0) {
    return 0;
  }

  return ((current - past) / past) * 100;
}

export function macd(values = [], fast = 12, slow = 26, signal = 9) {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));

  if (nums.length < slow) {
    return {
      macdLine: 0,
      signalLine: 0,
      histogram: 0
    };
  }

  const fastEma = emaSeries(nums, fast);
  const slowEma = emaSeries(nums, slow);

  const macdSeries = nums.map((_, i) => {
    return Number(fastEma[i] || 0) - Number(slowEma[i] || 0);
  });

  const signalSeries = emaSeries(macdSeries, signal);

  const macdLine = Number(macdSeries.at(-1) || 0);
  const signalLine = Number(signalSeries.at(-1) || 0);

  return {
    macdLine,
    signalLine,
    histogram: macdLine - signalLine
  };
}

export function bollingerBands(values = [], period = 20, multiplier = 2) {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));

  if (nums.length < period) {
    const last = nums.at(-1) || 0;
    return {
      middle: last,
      upper: last,
      lower: last,
      width: 0
    };
  }

  const slice = nums.slice(-period);
  const middle = slice.reduce((sum, v) => sum + v, 0) / slice.length;
  const variance =
    slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / slice.length;
  const std = Math.sqrt(variance);

  const upper = middle + std * multiplier;
  const lower = middle - std * multiplier;

  return {
    middle,
    upper,
    lower,
    width: middle !== 0 ? ((upper - lower) / middle) * 100 : 0
  };
}

export function stochastic(highs = [], lows = [], closes = [], period = 14) {
  const h = highs.map(Number).filter(Number.isFinite);
  const l = lows.map(Number).filter(Number.isFinite);
  const c = closes.map(Number).filter(Number.isFinite);

  if (h.length < period || l.length < period || c.length < period) {
    return 50;
  }

  const recentHigh = Math.max(...h.slice(-period));
  const recentLow = Math.min(...l.slice(-period));
  const close = c.at(-1);

  if (recentHigh === recentLow) return 50;

  return ((close - recentLow) / (recentHigh - recentLow)) * 100;
      }
