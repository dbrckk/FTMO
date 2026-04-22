// ==========================
// scan.js
// ==========================
import { API } from "./config.js";
import { appState } from "./state.js";
import { clamp } from "./utils.js";
import { ema, rsi } from "./indicators.js";

export async function scanPair(pair) {

  let candles = [];

  try {
    const r = await fetch(API.market, {
      method: "POST",
      body: JSON.stringify({ pair: pair.symbol })
    });

    const d = await r.json();
    candles = d.candles;

  } catch {
    candles = fakeCandles();
  }

  const closes = candles.map(c => c.close);
  const ema20 = ema(closes, 20).at(-1);
  const ema50 = ema(closes, 50).at(-1);

  const trend = ema20 > ema50 ? 80 : 30;
  const timing = rsi(closes);

  const scan = {
    pair: pair.symbol,
    candles,
    trendScore: trend,
    timingScore: timing,
    finalScore: clamp((trend + timing) / 2)
  };

  return scan;
}

function fakeCandles() {
  let arr = [];
  let p = 1;
  for (let i = 0; i < 100; i++) {
    let o = p;
    let c = o + (Math.random() - 0.5) * 0.01;
    arr.push({ open: o, close: c, high: c + 0.01, low: c - 0.01 });
    p = c;
  }
  return arr;
}
