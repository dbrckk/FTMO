// config.js

export const STORAGE_KEY = "ftmo-edge-ai-v4";

export const TIMEFRAMES = ["M5", "M15", "H1", "H4"];

export const PAIRS = [
  { symbol: "EURUSD", group: "forex", tier: 1 },
  { symbol: "GBPUSD", group: "forex", tier: 1 },
  { symbol: "USDJPY", group: "yen", tier: 1 },
  { symbol: "XAUUSD", group: "metals", tier: 2 },
  { symbol: "NAS100", group: "indices", tier: 2 }
];

export const API = {
  market: "/api/market-data",
  ml: "/api/ml-score",
  vectorbt: "/api/vectorbt-score",
  ai: "/api/ai-decision",
  exit: "/api/exit-engine",
  correlation: "/api/correlation-matrix",
  portfolio: "/api/portfolio-risk"
};
