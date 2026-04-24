CREATE TABLE IF NOT EXISTS market_candles (
  pair TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  source TEXT DEFAULT 'unknown',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (pair, timeframe, ts)
);

CREATE INDEX IF NOT EXISTS idx_market_candles_pair_tf_ts
ON market_candles (pair, timeframe, ts DESC);

CREATE INDEX IF NOT EXISTS idx_market_candles_pair_tf_source
ON market_candles (pair, timeframe, source);

CREATE TABLE IF NOT EXISTS paper_trades (
  id TEXT PRIMARY KEY,
  pair TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL,
  opened_at TEXT,
  closed_at TEXT,
  entry REAL,
  exit REAL,
  stop_loss REAL,
  take_profit REAL,
  pnl REAL DEFAULT 0,
  pnl_r REAL DEFAULT 0,
  win INTEGER DEFAULT 0,
  session TEXT DEFAULT 'OffSession',
  hour INTEGER DEFAULT 0,
  ultra_score REAL DEFAULT 0,
  ml_score REAL DEFAULT 0,
  vectorbt_score REAL DEFAULT 0,
  archive_edge_score REAL DEFAULT 0,
  close_reason TEXT,
  source TEXT DEFAULT 'paper-engine',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_pair_tf
ON paper_trades (pair, timeframe);

CREATE INDEX IF NOT EXISTS idx_paper_trades_closed_at
ON paper_trades (closed_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_trades_pair_direction
ON paper_trades (pair, direction);

CREATE INDEX IF NOT EXISTS idx_paper_trades_session_hour
ON paper_trades (session, hour);

CREATE INDEX IF NOT EXISTS idx_paper_trades_pair_tf_closed
ON paper_trades (pair, timeframe, closed_at DESC);
