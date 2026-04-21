from flask import Flask, request, jsonify
import pandas as pd

app = Flask(__name__)

@app.route("/")
def home():
    return "VectorBT API running"

@app.route("/backtest", methods=["POST"])
def backtest():
    data = request.json
    candles = data.get("candles", [])

    if not candles:
        return jsonify({"error": "no data"})

    closes = [c["close"] for c in candles]

    df = pd.Series(closes)

    returns = df.pct_change().dropna()

    total_return = returns.sum()
    win_rate = (returns > 0).mean()

    return jsonify({
        "total_return": float(total_return),
        "win_rate": float(win_rate),
        "max_drawdown": float(df.min())
    })

app.run(host="0.0.0.0", port=10000)
