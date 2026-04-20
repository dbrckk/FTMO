from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import pandas as pd
import numpy as np
import vectorbt as vbt
import talib

app = FastAPI(title="FTMO Edge VectorBT Service")


class Candle(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float


class BacktestPayload(BaseModel):
    pair: str
    timeframe: str
    candles: List[Candle]
    fee: float = 0.0002
    slippage: float = 0.0001

    fast_ema: int = 20
    slow_ema: int = 50
    rsi_period: int = 14
    atr_period: int = 14
    macd_fast: int = 12
    macd_slow: int = 26
    macd_signal: int = 9

    rsi_buy_min: float = 45
    rsi_buy_max: float = 65
    rsi_sell_min: float = 35
    rsi_sell_max: float = 55

    stop_atr_mult: float = 1.4
    take_atr_mult: float = 2.6


def build_dataframe(candles: List[Candle]) -> pd.DataFrame:
    if len(candles) < 120:
      raise HTTPException(status_code=400, detail="Not enough candles for backtest")

    df = pd.DataFrame([c.model_dump() for c in candles])
    df["datetime"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df = df.set_index("datetime").sort_index()

    for col in ["open", "high", "low", "close"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna()
    if len(df) < 120:
        raise HTTPException(status_code=400, detail="Not enough clean candles after preprocessing")

    return df


def add_indicators(df: pd.DataFrame, payload: BacktestPayload) -> pd.DataFrame:
    close = df["close"].values.astype(float)
    high = df["high"].values.astype(float)
    low = df["low"].values.astype(float)

    df["ema_fast"] = talib.EMA(close, timeperiod=payload.fast_ema)
    df["ema_slow"] = talib.EMA(close, timeperiod=payload.slow_ema)
    df["rsi"] = talib.RSI(close, timeperiod=payload.rsi_period)
    df["atr"] = talib.ATR(high, low, close, timeperiod=payload.atr_period)

    macd, macd_signal, macd_hist = talib.MACD(
        close,
        fastperiod=payload.macd_fast,
        slowperiod=payload.macd_slow,
        signalperiod=payload.macd_signal
    )
    df["macd"] = macd
    df["macd_signal"] = macd_signal
    df["macd_hist"] = macd_hist

    upper, middle, lower = talib.BBANDS(close, timeperiod=20)
    df["bb_upper"] = upper
    df["bb_middle"] = middle
    df["bb_lower"] = lower

    df["adx"] = talib.ADX(high, low, close, timeperiod=14)
    df["plus_di"] = talib.PLUS_DI(high, low, close, timeperiod=14)
    df["minus_di"] = talib.MINUS_DI(high, low, close, timeperiod=14)

    return df.dropna().copy()


def build_long_signals(df: pd.DataFrame, payload: BacktestPayload):
    trend_ok = df["ema_fast"] > df["ema_slow"]
    rsi_ok = (df["rsi"] >= payload.rsi_buy_min) & (df["rsi"] <= payload.rsi_buy_max)
    macd_ok = df["macd_hist"] > 0
    adx_ok = df["adx"] >= 18
    breakout_ok = df["close"] > df["bb_middle"]

    entries = trend_ok & rsi_ok & macd_ok & adx_ok & breakout_ok

    exits = (
        (df["ema_fast"] < df["ema_slow"]) |
        (df["rsi"] >= 72) |
        (df["macd_hist"] < 0) |
        (df["close"] < df["bb_middle"])
    )

    return entries.fillna(False), exits.fillna(False)


def build_short_signals(df: pd.DataFrame, payload: BacktestPayload):
    trend_ok = df["ema_fast"] < df["ema_slow"]
    rsi_ok = (df["rsi"] >= payload.rsi_sell_min) & (df["rsi"] <= payload.rsi_sell_max)
    macd_ok = df["macd_hist"] < 0
    adx_ok = df["adx"] >= 18
    breakdown_ok = df["close"] < df["bb_middle"]

    entries = trend_ok & rsi_ok & macd_ok & adx_ok & breakdown_ok

    exits = (
        (df["ema_fast"] > df["ema_slow"]) |
        (df["rsi"] <= 28) |
        (df["macd_hist"] > 0) |
        (df["close"] > df["bb_middle"])
    )

    return entries.fillna(False), exits.fillna(False)


def portfolio_stats_to_dict(stats: pd.Series) -> Dict[str, Any]:
    def f(key: str, default=0.0):
        val = stats.get(key, default)
        try:
            return float(val)
        except Exception:
            return default

    def i(key: str, default=0):
        val = stats.get(key, default)
        try:
            return int(val)
        except Exception:
            return default

    total_return = f("Total Return [%]")
    win_rate = f("Win Rate [%]")
    max_drawdown = abs(f("Max Drawdown [%]"))
    total_trades = i("Total Trades")
    profit_factor = f("Profit Factor")
    sharpe = f("Sharpe Ratio")
    calmar = f("Calmar Ratio")
    expectancy = total_return / total_trades if total_trades > 0 else 0.0

    return {
        "totalReturnPct": total_return,
        "winRatePct": win_rate,
        "maxDrawdownPct": max_drawdown,
        "totalTrades": total_trades,
        "profitFactor": profit_factor,
        "sharpeRatio": sharpe,
        "calmarRatio": calmar,
        "expectancy": expectancy
    }


def compute_vectorbt_score(metrics: Dict[str, Any]) -> int:
    score = 50.0

    total_return = metrics["totalReturnPct"]
    win_rate = metrics["winRatePct"]
    max_drawdown = metrics["maxDrawdownPct"]
    total_trades = metrics["totalTrades"]
    profit_factor = metrics["profitFactor"]
    sharpe = metrics["sharpeRatio"]
    calmar = metrics["calmarRatio"]

    score += min(18, max(0, total_return / 4))
    score += min(12, max(0, (win_rate - 45) * 0.6))
    score += min(10, max(0, (profit_factor - 1) * 8))
    score += min(8, max(0, sharpe * 3))
    score += min(6, max(0, calmar * 2))

    score -= min(22, max(0, max_drawdown * 0.8))

    if total_trades < 8:
        score -= 8
    elif total_trades < 15:
        score -= 4

    return max(1, min(99, round(score)))


def confidence_band(score: int) -> str:
    if score >= 80:
        return "high"
    if score >= 60:
        return "medium"
    return "low"


def choose_best_side(long_metrics: Dict[str, Any], short_metrics: Dict[str, Any]):
    long_score = compute_vectorbt_score(long_metrics)
    short_score = compute_vectorbt_score(short_metrics)

    if long_score >= short_score:
        return "long", long_score, long_metrics
    return "short", short_score, short_metrics


@app.get("/health")
def health():
    return {"ok": True, "service": "vectorbt-ta-lib"}


@app.post("/backtest")
def run_backtest(payload: BacktestPayload):
    df = build_dataframe(payload.candles)
    df = add_indicators(df, payload)

    if len(df) < 80:
        raise HTTPException(status_code=400, detail="Not enough indicator-ready candles")

    close = df["close"]

    long_entries, long_exits = build_long_signals(df, payload)
    short_entries, short_exits = build_short_signals(df, payload)

    pf_long = vbt.Portfolio.from_signals(
        close=close,
        entries=long_entries,
        exits=long_exits,
        fees=payload.fee,
        slippage=payload.slippage,
        init_cash=10_000,
        freq="1T"
    )

    pf_short = vbt.Portfolio.from_signals(
        close=close,
        entries=short_entries,
        exits=short_exits,
        short_entries=short_entries,
        short_exits=short_exits,
        direction="shortonly",
        fees=payload.fee,
        slippage=payload.slippage,
        init_cash=10_000,
        freq="1T"
    )

    long_stats = portfolio_stats_to_dict(pf_long.stats())
    short_stats = portfolio_stats_to_dict(pf_short.stats())

    best_side, best_score, best_metrics = choose_best_side(long_stats, short_stats)

    explanation = (
        f"VectorBT {payload.pair} {payload.timeframe}: "
        f"best side={best_side}, return {best_metrics['totalReturnPct']:.2f}%, "
        f"win rate {best_metrics['winRatePct']:.2f}%, "
        f"drawdown {best_metrics['maxDrawdownPct']:.2f}%, "
        f"PF {best_metrics['profitFactor']:.2f}, "
        f"Sharpe {best_metrics['sharpeRatio']:.2f}."
    )

    return {
        "ok": True,
        "source": "vectorbt-talib",
        "pair": payload.pair,
        "timeframe": payload.timeframe,
        "bestSide": best_side,
        "vectorbtScore": best_score,
        "confidenceBand": confidence_band(best_score),
        "explanation": explanation,
        "metrics": best_metrics,
        "longMetrics": long_stats,
        "shortMetrics": short_stats
    }
