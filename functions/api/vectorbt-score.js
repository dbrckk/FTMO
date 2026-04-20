export async function onRequestPost(context) {
  try {
    const env = context.env || {};
    const vectorbtUrl = env.VECTORBT_SERVICE_URL || "";

    if (!vectorbtUrl) {
      return json({
        ok: false,
        error: "Missing VECTORBT_SERVICE_URL"
      }, 500);
    }

    const payload = await safeJson(context.request);
    if (!payload.ok) {
      return json({
        ok: false,
        error: "Invalid JSON body"
      }, 400);
    }

    const normalized = normalizePayload(payload.data);

    const response = await fetch(`${vectorbtUrl.replace(/\/$/, "")}/backtest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(normalized)
    });

    const text = await response.text();

    return new Response(text, {
      status: response.status,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store"
      }
    });
  } catch {
    return json({
      ok: false,
      error: "VectorBT proxy failed"
    }, 500);
  }
}

function normalizePayload(data) {
  return {
    pair: cleanText(data.pair, "EURUSD"),
    timeframe: cleanText(data.timeframe, "M15"),
    candles: Array.isArray(data.candles)
      ? data.candles
          .slice(-500)
          .map((c) => ({
            time: Number(c.time) || 0,
            open: Number(c.open) || 0,
            high: Number(c.high) || 0,
            low: Number(c.low) || 0,
            close: Number(c.close) || 0
          }))
          .filter((c) =>
            c.time > 0 &&
            c.open > 0 &&
            c.high > 0 &&
            c.low > 0 &&
            c.close > 0
          )
      : [],
    fee: clampNumber(data.fee, 0, 0.01, 0.0002),
    slippage: clampNumber(data.slippage, 0, 0.01, 0.0001),
    fast_ema: clampInt(data.fast_ema, 5, 100, 20),
    slow_ema: clampInt(data.slow_ema, 10, 200, 50),
    rsi_period: clampInt(data.rsi_period, 5, 50, 14),
    atr_period: clampInt(data.atr_period, 5, 50, 14),
    macd_fast: clampInt(data.macd_fast, 5, 30, 12),
    macd_slow: clampInt(data.macd_slow, 10, 60, 26),
    macd_signal: clampInt(data.macd_signal, 3, 30, 9),
    rsi_buy_min: clampNumber(data.rsi_buy_min, 1, 99, 45),
    rsi_buy_max: clampNumber(data.rsi_buy_max, 1, 99, 65),
    rsi_sell_min: clampNumber(data.rsi_sell_min, 1, 99, 35),
    rsi_sell_max: clampNumber(data.rsi_sell_max, 1, 99, 55),
    stop_atr_mult: clampNumber(data.stop_atr_mult, 0.1, 10, 1.4),
    take_atr_mult: clampNumber(data.take_atr_mult, 0.1, 20, 2.6)
  };
}

async function safeJson(request) {
  try {
    return { ok: true, data: await request.json() };
  } catch {
    return { ok: false };
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanText(value, fallback) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 40) : fallback;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
      }
