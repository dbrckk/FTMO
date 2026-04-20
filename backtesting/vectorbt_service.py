from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import pandas as pd
import numpy as np
import vectorbt as vbt

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
    rsi_buy_min: float = 45
    rsi_buy_max: float = 65
    atr_period: int = 14
    stop_atr_mult: float = 1.4
    take_atr_mult: float = 2.6


def build_dataframe(candles: List[Candle]) -> pd.DataFrame:
    if len(candles) < 60:
        raise HTTPException(status_code=400, detail="Not enough candles for backtest")

    df = pd.DataFrame([c.model_dump() for c in candles])
    df["datetime"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df = df.set_index("datetime").sort_index()
    return df


def compute_atr(df: pd.DataFrame, period: int) -> pd.Series:
    high = df["high"]
    low = df["low"]
    close = df["close"]
    prev_close = close.shift(1)

    tr = pd.concat(
        [
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs()
        ],
        axis=1
    ).max(axis=1)

    return tr.rolling(period).mean()


@app.post("/backtest")
def run_backtest(payload: BacktestPayload):
    df = build_dataframe(payload.candles)

    close = df["close"]
    fast = vbt.MA.run(close, payload.fast_ema).ma
    slow = vbt.MA.run(close, payload.slow_ema).ma
    rsi = vbt.RSI.run(close, payload.rsi_period).rsi
    atr = compute_atr(df, payload.atr_period)

    long_entries = (fast > slow) & (rsi >= payload.rsi_buy_min) & (rsi <= payload.rsi_buy_max)
    long_exits = (fast < slow) | (rsi > 72) | (rsi < 35)

    pf = vbt.Portfolio.from_signals(
        close=close,
        entries=long_entries.fillna(False),
        exits=long_exits.fillna(False),
        fees=payload.fee,
        slippage=payload.slippage,
        init_cash=10_000,
        freq="1T"
    )

    stats = pf.stats()

    total_return = float(stats.get("Total Return [%]", 0.0))
    win_rate = float(stats.get("Win Rate [%]", 0.0))
    max_drawdown = float(stats.get("Max Drawdown [%]", 0.0))
    total_trades = int(stats.get("Total Trades", 0) or 0)
    profit_factor = float(stats.get("Profit Factor", 0.0) or 0.0)
    sharpe = float(stats.get("Sharpe Ratio", 0.0) or 0.0)

    expectancy = 0.0
    if total_trades > 0:
        expectancy = total_return / total_trades

    score = 50.0
    score += min(18, max(0, total_return / 4))
    score += min(12, max(0, (win_rate - 45) * 0.6))
    score += min(10, max(0, (profit_factor - 1) * 8))
    score += min(8, max(0, sharpe * 3))
    score -= min(20, max(0, max_drawdown * 0.8))

    confidence_band = "low"
    if score >= 75:
        confidence_band = "high"
    elif score >= 60:
        confidence_band = "medium"

    explanation = (
        f"Backtest {payload.pair} {payload.timeframe}: "
        f"return {total_return:.2f}%, win rate {win_rate:.2f}%, "
        f"drawdown {max_drawdown:.2f}%, PF {profit_factor:.2f}, Sharpe {sharpe:.2f}."
    )

    return {
        "ok": True,
        "source": "vectorbt",
        "pair": payload.pair,
        "timeframe": payload.timeframe,
        "vectorbtScore": max(1, min(99, round(score))),
        "confidenceBand": confidence_band,
        "explanation": explanation,
        "metrics": {
            "totalReturnPct": total_return,
            "winRatePct": win_rate,
            "maxDrawdownPct": max_drawdown,
            "totalTrades": total_trades,
            "profitFactor": profit_factor,
            "sharpeRatio": sharpe,
            "expectancy": expectancy
        }
  }
