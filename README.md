# FTMO EDGE AI
 
Application de scan trading mobile-first avec :

- Cloudflare Pages pour le front
- Cloudflare Functions pour les endpoints `/api/*`
- Render pour le backend Python simple
- Twelve Data pour les données marché
- Groq pour la décision IA
- service backtest HTTP externe relié via `VECTORBT_SERVICE_URL`

## Structure

```txt
/
  index.html
  styles.css
  app.js
  _routes.json
  _headers
  _middleware.js
  package.json
  requirements.txt
  app.py
  README.md
  /functions
    /api
      health.js
      market-data.js
      ml-score.js
      ai-decision.js
      vectorbt-score.js
      macro-context.js
      risk-engine.js
      exit-engine.js
      journal-insights.js
