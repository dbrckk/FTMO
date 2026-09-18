# Repo Brain

- Files indexed: 51
- Symbols: 825
- Internal import edges: 0

## Languages
- javascript: 50 files
- python: 1 files

## Highest-density symbol files
- functions/api/paper-run.js: 76 symbols
- scan.js: 46 symbols
- paper-engine.js: 32 symbols
- functions/api/vectorbt-score.js: 31 symbols
- app.js: 28 symbols
- functions/_shared/ftmo-guardian.js: 28 symbols
- functions/api/import-market-csv.js: 28 symbols
- render.js: 27 symbols
- functions/api/analytics-engine.js: 26 symbols
- functions/api/mt5-sync.js: 26 symbols
- functions/api/ai-decision.js: 22 symbols
- functions/api/ml-score.js: 22 symbols
- functions/api/paper-trades.js: 21 symbols
- functions/_shared/archive-intelligence.js: 20 symbols
- backtesting/vectorbt_service.py: 19 symbols
- functions/api/correlation-matrix.js: 19 symbols
- functions/api/exit-engine.js: 19 symbols
- functions/_shared/news-filter.js: 18 symbols
- functions/api/ftmo-status.js: 18 symbols
- advanced-engine.js: 17 symbols

## Agent routing
- Search lookup.json first for direct symbol-to-file routing.
- Use symbols.json only when broader symbol metadata is needed.
- Use code-graph.json to inspect likely internal import relationships.
- Use imports.json when a changed file crosses module boundaries.
- Treat graph edges as static hints; verify source before editing.

## ast-grep enrichment
- ast-grep outline: available
- outline files: 50
- top-level items: 956
- direct members: 20
- symbol shards: 23
- route named symbols via ast-routing.json, then fetch one ast-symbols/<initial>.json shard

