// ==========================
// indicators.js
// ==========================
export function ema(values, p) {
  let k = 2 / (p + 1);
  let out = [];
  let prev = values[0];

  values.forEach((v, i) => {
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  });

  return out;
}

export function rsi(values, p = 14) {
  let gains = 0, losses = 0;
  for (let i = values.length - p; i < values.length; i++) {
    let d = values[i] - values[i - 1];
    if (d > 0) gains += d;
    else losses += Math.abs(d);
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
}
