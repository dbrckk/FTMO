// mock.js

export function generateFakeCandles(symbol) {
  const candles = [];

  let price =
    symbol === "XAUUSD" ? 2300 :
    symbol === "NAS100" ? 18000 :
    symbol === "USDJPY" ? 150 :
    1.08;

  for (let i = 0; i < 120; i++) {

    const open = price;

    const volatility =
      symbol === "XAUUSD" ? 3 :
      symbol === "NAS100" ? 40 :
      symbol === "USDJPY" ? 0.25 :
      0.004;

    const close = open + (Math.random() - 0.5) * volatility;

    const high = Math.max(open, close) + Math.random() * (volatility * 0.3);
    const low = Math.min(open, close) - Math.random() * (volatility * 0.3);

    candles.push({
      time: i + 1,
      open,
      high,
      low,
      close
    });

    price = close;
  }

  return candles;
}
