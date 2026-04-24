export function generateFakeCandles(pair = "EURUSD", count = 220) {
  const base = getBasePrice(pair);
  const step = getStep(pair);

  const candles = [];
  let price = base;
  let time = Math.floor(Date.now() / 1000) - count * 900;

  for (let i = 0; i < count; i += 1) {
    const wave = Math.sin(i / 8) * step * 1.2;
    const trend = Math.sin(i / 35) * step * 0.6;
    const noise = pseudoNoise(pair, i) * step;

    const open = price;
    const close = open + wave + trend + noise;
    const high = Math.max(open, close) + Math.abs(noise) * 0.8 + step * 0.35;
    const low = Math.min(open, close) - Math.abs(noise) * 0.8 - step * 0.35;

    candles.push({
      time,
      open: roundByPair(open, pair),
      high: roundByPair(high, pair),
      low: roundByPair(low, pair),
      close: roundByPair(close, pair)
    });

    price = close;
    time += 900;
  }

  return candles;
}

export function generateFakeArchiveTrades(pair = "EURUSD", count = 80) {
  const trades = [];
  const now = Date.now();

  for (let i = 0; i < count; i += 1) {
    const win = pseudoNoise(pair, i) > -0.15;
    const pnlR = win
      ? 0.5 + Math.abs(pseudoNoise(pair, i + 5)) * 1.8
      : -0.35 - Math.abs(pseudoNoise(pair, i + 9)) * 0.9;

    const closedAt = new Date(now - i * 3600 * 1000 * 6).toISOString();
    const openedAt = new Date(now - i * 3600 * 1000 * 6 - 3600 * 1000).toISOString();

    trades.push({
      id: `fake_${pair}_${i}`,
      pair,
      timeframe: "M15",
      direction: i % 2 === 0 ? "buy" : "sell",
      openedAt,
      closedAt,
      entry: getBasePrice(pair),
      exitPrice: getBasePrice(pair),
      stopLoss: getBasePrice(pair),
      takeProfit: getBasePrice(pair),
      pnlR: Number(pnlR.toFixed(3)),
      pnl: Number((pnlR * 25).toFixed(2)),
      win: pnlR > 0 ? 1 : 0,
      session: getFakeSession(i),
      hour: i % 24,
      modelTag: "mock",
      closeReason: win ? "take-profit" : "stop-loss"
    });
  }

  return trades;
}

function getBasePrice(pair) {
  const prices = {
    EURUSD: 1.0835,
    GBPUSD: 1.2710,
    USDJPY: 151.15,
    USDCHF: 0.9030,
    USDCAD: 1.3520,
    AUDUSD: 0.6610,
    NZDUSD: 0.6070,

    EURGBP: 0.8510,
    EURJPY: 163.40,
    EURCHF: 0.9780,
    EURCAD: 1.4650,
    EURAUD: 1.6390,
    EURNZD: 1.7750,

    GBPJPY: 192.30,
    GBPCHF: 1.1490,
    GBPCAD: 1.7190,
    GBPAUD: 1.9240,
    GBPNZD: 2.0830,

    AUDJPY: 99.10,
    AUDCAD: 0.8940,
    AUDCHF: 0.5970,
    AUDNZD: 1.0820,

    NZDJPY: 91.70,
    NZDCAD: 0.8220,

    XAUUSD: 2350.50
  };

  return prices[pair] || 1;
}

function getStep(pair) {
  if (pair === "XAUUSD") return 3.5;
  if (String(pair).includes("JPY")) return 0.16;
  return 0.0012;
}

function roundByPair(value, pair) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  if (pair === "XAUUSD") return Number(n.toFixed(2));
  if (String(pair).includes("JPY")) return Number(n.toFixed(3));
  return Number(n.toFixed(5));
}

function pseudoNoise(pair, index) {
  const seed = hashCode(`${pair}_${index}`);
  const x = Math.sin(seed) * 10000;
  return (x - Math.floor(x)) - 0.5;
}

function hashCode(str) {
  let hash = 0;

  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }

  return Math.abs(hash);
}

function getFakeSession(index) {
  const sessions = ["Tokyo", "London", "London+NewYork", "NewYork", "OffSession"];
  return sessions[index % sessions.length];
      }
