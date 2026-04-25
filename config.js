export const STORAGE_KEY = "ftmo-edge-ai-v7";

export const TIMEFRAMES = ["M5", "M15", "H1", "H4"];

export const PAIRS = [
  { symbol: "EURUSD", group: "forex", tier: 1 },
  { symbol: "GBPUSD", group: "forex", tier: 1 },
  { symbol: "USDJPY", group: "yen", tier: 1 },
  { symbol: "USDCHF", group: "forex", tier: 1 },
  { symbol: "USDCAD", group: "forex", tier: 1 },
  { symbol: "AUDUSD", group: "forex", tier: 1 },
  { symbol: "NZDUSD", group: "forex", tier: 1 },

  { symbol: "EURGBP", group: "cross", tier: 2 },
  { symbol: "EURJPY", group: "cross", tier: 2 },
  { symbol: "EURCHF", group: "cross", tier: 2 },
  { symbol: "EURCAD", group: "cross", tier: 2 },
  { symbol: "EURAUD", group: "cross", tier: 2 },
  { symbol: "EURNZD", group: "cross", tier: 2 },

  { symbol: "GBPJPY", group: "cross", tier: 2 },
  { symbol: "GBPCHF", group: "cross", tier: 2 },
  { symbol: "GBPCAD", group: "cross", tier: 2 },
  { symbol: "GBPAUD", group: "cross", tier: 2 },
  { symbol: "GBPNZD", group: "cross", tier: 2 },

  { symbol: "AUDJPY", group: "cross", tier: 2 },
  { symbol: "AUDCAD", group: "cross", tier: 2 },
  { symbol: "AUDCHF", group: "cross", tier: 2 },
  { symbol: "AUDNZD", group: "cross", tier: 2 },

  { symbol: "NZDJPY", group: "cross", tier: 2 },
  { symbol: "NZDCAD", group: "cross", tier: 2 },

  { symbol: "XAUUSD", group: "metals", tier: 2 }
];

export const API = {
  paperHealth: "/api/paper-health"
  market: "/api/market-data",
  ml: "/api/ml-score",
  vectorbt: "/api/vectorbt-score",
  ai: "/api/ai-decision",
  exit: "/api/exit-engine",
  correlation: "/api/correlation-matrix",
  portfolio: "/api/portfolio-risk",
  archiveStats: "/api/archive-stats",
  paperTrades: "/api/paper-trades"
};
