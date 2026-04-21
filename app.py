from fastapi import FastAPI

app = FastAPI(title="FTMO Legacy Placeholder")

@app.get("/")
def root():
    return {
        "ok": True,
        "message": "Legacy placeholder. Active backend is backtesting/vectorbt_service.py"
    }
