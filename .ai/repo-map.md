This file is a merged representation of a subset of the codebase, containing specifically included files and files not matching ignore patterns, combined into a single document by Repomix.
The content has been processed where content has been compressed (code blocks are separated by ⋮---- delimiter).

# File Summary

## Purpose
This file contains a packed representation of a subset of the repository's contents that is considered the most important context.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes.

## File Format
The content is organized as follows:
1. This summary section
2. Repository information
3. Directory structure
4. Repository files (if enabled)
5. Multiple file entries, each consisting of:
  a. A header with the file path (## File: path/to/file)
  b. The full contents of the file in a code block

## Usage Guidelines
- This file should be treated as read-only. Any changes should be made to the
  original repository files, not this packed version.
- When processing this file, use the file path to distinguish
  between different files in the repository.
- Be aware that this file may contain sensitive information. Handle it with
  the same level of security as you would the original repository.

## Notes
- Some files may have been excluded based on .gitignore rules and Repomix's configuration
- Binary files are not included in this packed representation. Please refer to the Repository Structure section for a complete list of file paths, including binary files
- Only files matching these patterns are included: **/*.{py,js,mjs,cjs,ts,tsx,jsx,java,kt,kts,gd,groovy,gradle,toml,json,yaml,yml,sql,sh}, README.md, AGENTS.md, PROJECT_*.md
- Files matching these patterns are excluded: .ai/**, **/node_modules/**, **/.gradle/**, **/build/**, **/dist/**, **/.venv/**, **/__pycache__/**, **/.pytest_cache/**, **/.git/**, **/coverage/**, **/*.lock, **/*.min.js, **/*.map, assets/**, art/**, art_sources/**, marketing/**, colab/**, kaggle/**, discovery-cache.json, health-snapshot.json, history.json
- Files matching patterns in .gitignore are excluded
- Files matching default ignore patterns are excluded
- Content has been compressed - code blocks are separated by ⋮---- delimiter
- Files are sorted by Git change count (files with more changes are at the bottom)

# Directory Structure
````
.github/
  workflows/
    ai-repo-map.yml
    paper-health.yml
    paper-run.yml
    semantic-refresh.yml
    server-trading.yml
    setup-alerts.yml
    smoke-test.yml
    sync-all-market.yml
    sync-market.yml
    validate-code.yml
.serena/
  project.yml
backtesting/
  vectorbt_service.py
functions/
  _shared/
    archive-intelligence.js
    ftmo-guardian.js
    model-rules.js
    news-filter.js
    realistic-execution.js
  api/
    ai-decision.js
    analytics-engine.js
    archive-stats.js
    correlation-matrix.js
    exit-engine.js
    ftmo-status.js
    health.js
    import-market-csv.js
    journal-insights.js
    macro-context.js
    macro-feed.js
    market-data.js
    ml-score.js
    mt5-sync.js
    news-events.js
    paper-health.js
    paper-run.js
    paper-trades.js
    portfolio-risk.js
    quotes.js
    reset-paper-guard.js
    risk-engine.js
    server-trading.js
    setup-alerts.js
    sync-market.js
    timeframe-summary.js
    vectorbt-score.js
  _middleware.js
scripts/
  import-dukascopy-csv-to-sql.mjs
_routes.json
.repo-standards.yml
advanced-engine.js
AGENTS.md
api.js
app.js
archive-engine.js
chart.js
config.js
d1-schema.sql
indicators.js
integration-patch.js
mock.js
package.json
paper-engine.js
README.md
render.js
scan.js
setup-classifier.js
state.js
trades.js
utils.js
````

# Files

## File: .github/workflows/ai-repo-map.yml
````yaml
name: Repository standards

on:
  push:
    branches: [main]
    paths-ignore:
      - ".ai/**"
  workflow_dispatch:

permissions:
  contents: write
  actions: read

concurrency:
  group: repo-standards-${{ github.repository }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  repository-standards:
    uses: dbrckk/repo-standards/.github/workflows/reusable-unified.yml@main
````

## File: .github/workflows/paper-health.yml
````yaml
name: Paper server health check

on:
  workflow_dispatch:
    inputs:
      timeframe:
        description: "M5, M15, H1, H4, or AUTO"
        required: false
        default: "AUTO"
  schedule:
    - cron: "*/15 * * * *"

jobs:
  health-check:
    runs-on: ubuntu-latest

    steps:
      - name: Check secrets presence
        run: |
          if [ -z "${{ secrets.SITE_URL }}" ]; then
            echo "ERROR: SITE_URL missing"
            exit 1
          fi

          echo "SITE_URL present"

      - name: Compute health timeframe
        id: vars
        shell: bash
        run: |
          MANUAL_TIMEFRAME="${{ github.event.inputs.timeframe }}"
          SLOT=$(( $(date -u +%s) / 900 ))

          if [ -n "$MANUAL_TIMEFRAME" ] && [ "$MANUAL_TIMEFRAME" != "AUTO" ]; then
            TIMEFRAME="$MANUAL_TIMEFRAME"
          else
            MOD=$(( SLOT % 16 ))

            if [ "$MOD" -eq 0 ]; then
              TIMEFRAME="H4"
            elif [ "$MOD" -eq 4 ] || [ "$MOD" -eq 8 ] || [ "$MOD" -eq 12 ]; then
              TIMEFRAME="H1"
            else
              TIMEFRAME="M15"
            fi
          fi

          echo "timeframe=$TIMEFRAME" >> "$GITHUB_OUTPUT"
          echo "Using health timeframe $TIMEFRAME"

      - name: Check paper server health
        run: |
          HTTP_CODE=$(curl -sS \
            -o health.json \
            -w "%{http_code}" \
            "${{ secrets.SITE_URL }}/api/paper-health?timeframe=${{ steps.vars.outputs.timeframe }}")

          echo "HTTP_CODE=$HTTP_CODE"
          cat health.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "Health endpoint HTTP error"
            exit 1
          fi

          STATUS=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('health.json','utf8')); console.log(j.status || 'UNKNOWN')")
          HEALTHY=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('health.json','utf8')); console.log(j.healthy === true ? 'true' : 'false')")
          FRESH=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('health.json','utf8')); console.log(j.market?.freshPairs ?? 0)")
          STALE=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('health.json','utf8')); console.log(j.market?.stalePairs ?? 0)")
          MISSING=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('health.json','utf8')); console.log(j.market?.missingPairs ?? 0)")
          LAST_RUN=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('health.json','utf8')); console.log(j.paper?.lastRun?.ranAt || '')")

          echo "STATUS=$STATUS"
          echo "HEALTHY=$HEALTHY"
          echo "FRESH_PAIRS=$FRESH"
          echo "STALE_PAIRS=$STALE"
          echo "MISSING_PAIRS=$MISSING"
          echo "LAST_RUN=$LAST_RUN"

          if [ "$STATUS" = "UNHEALTHY" ]; then
            echo "Paper server is unhealthy"
            exit 1
          fi

          if [ "$MISSING" -gt 0 ]; then
            echo "Some pairs are missing market candles"
            exit 1
          fi

          echo "Paper server health check passed"
````

## File: .github/workflows/paper-run.yml
````yaml
name: Server paper run

on:
  workflow_dispatch:
    inputs:
      timeframe:
        description: "M5, M15, H1, H4, or AUTO"
        required: false
        default: "AUTO"

  schedule:
    - cron: "5,20,35,50 * * * *"

jobs:
  paper-run:
    runs-on: ubuntu-latest

    steps:
      - name: Check secrets presence
        run: |
          if [ -z "${{ secrets.SITE_URL }}" ]; then
            echo "ERROR: SITE_URL missing"
            exit 1
          fi

          if [ -z "${{ secrets.SYNC_SECRET }}" ]; then
            echo "ERROR: SYNC_SECRET missing"
            exit 1
          fi

          echo "SITE_URL present"
          echo "SYNC_SECRET present"

      - name: Compute paper timeframe
        id: vars
        shell: bash
        run: |
          MANUAL_TIMEFRAME="${{ github.event.inputs.timeframe }}"
          SLOT=$(( $(date -u +%s) / 900 ))

          if [ -n "$MANUAL_TIMEFRAME" ] && [ "$MANUAL_TIMEFRAME" != "AUTO" ]; then
            TIMEFRAME="$MANUAL_TIMEFRAME"
          else
            MOD=$(( SLOT % 16 ))

            if [ "$MOD" -eq 1 ]; then
              TIMEFRAME="H4"
            elif [ "$MOD" -eq 5 ] || [ "$MOD" -eq 9 ] || [ "$MOD" -eq 13 ]; then
              TIMEFRAME="H1"
            else
              TIMEFRAME="M15"
            fi
          fi

          echo "timeframe=$TIMEFRAME" >> "$GITHUB_OUTPUT"
          echo "Using timeframe $TIMEFRAME"

      - name: Run server paper engine
        run: |
          HTTP_CODE=$(curl -sS \
            -o response.json \
            -w "%{http_code}" \
            "${{ secrets.SITE_URL }}/api/paper-run?token=${{ secrets.SYNC_SECRET }}&timeframe=${{ steps.vars.outputs.timeframe }}")

          echo "HTTP_CODE=$HTTP_CODE"
          cat response.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "paper-run HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          SCANNED=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response.json','utf8')); console.log(j.scannedPairs ?? 0)")
          OPENED=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response.json','utf8')); console.log(j.opened ?? 0)")
          CLOSED=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response.json','utf8')); console.log(j.closed ?? 0)")

          echo "OK=$OK"
          echo "SCANNED=$SCANNED"
          echo "OPENED=$OPENED"
          echo "CLOSED=$CLOSED"

          if [ "$OK" != "true" ]; then
            echo "paper-run returned ok=false"
            exit 1
          fi

          if [ "$SCANNED" -le 0 ]; then
            echo "No pairs scanned"
            exit 1
          fi

      - name: Check paper health
        run: |
          HTTP_CODE=$(curl -sS \
            -o health.json \
            -w "%{http_code}" \
            "${{ secrets.SITE_URL }}/api/paper-health?timeframe=${{ steps.vars.outputs.timeframe }}")

          echo "HTTP_CODE=$HTTP_CODE"
          cat health.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "paper-health HTTP error"
            exit 1
          fi
````

## File: .github/workflows/semantic-refresh.yml
````yaml
name: Precise semantic refresh

on:
  workflow_dispatch:
  schedule:
    - cron: "23 3 * * 1"

permissions:
  contents: write

concurrency:
  group: semantic-refresh-${{ github.repository }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  semantic:
    uses: dbrckk/repo-brain/.github/workflows/reusable-semantic.yml@main
    with:
      commit_changes: true
````

## File: .github/workflows/server-trading.yml
````yaml
name: Server Trading Engine

on:
  schedule:
    - cron: "*/5 * * * *"

  workflow_dispatch:
    inputs:
      dryRun:
        description: "1 = test only, 0 = real paper run + alerts"
        required: false
        default: "0"

      timeframes:
        description: "Comma-separated timeframes: M5,M15,H1,H4"
        required: false
        default: "M15"

      sync:
        description: "Run market sync"
        required: false
        default: "1"

      health:
        description: "Run paper health check"
        required: false
        default: "1"

      paper:
        description: "Run paper trading"
        required: false
        default: "1"

      alerts:
        description: "Run setup alerts"
        required: false
        default: "1"

      analytics:
        description: "Run analytics engine"
        required: false
        default: "1"

      telegram:
        description: "Send Telegram alerts"
        required: false
        default: "1"

      forceAlerts:
        description: "Ignore alert cooldown"
        required: false
        default: "0"

concurrency:
  group: server-trading-engine
  cancel-in-progress: true

jobs:
  server-trading:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Validate secrets
        run: |
          set -e

          if [ -z "${{ secrets.SITE_URL }}" ]; then
            echo "❌ Missing GitHub secret: SITE_URL"
            exit 1
          fi

          if [ -z "${{ secrets.SYNC_SECRET }}" ]; then
            echo "❌ Missing GitHub secret: SYNC_SECRET"
            exit 1
          fi

          echo "✅ Required GitHub secrets exist"

      - name: Prepare variables
        env:
          SITE_URL_RAW: ${{ secrets.SITE_URL }}
          SYNC_SECRET: ${{ secrets.SYNC_SECRET }}

          DRY_RUN_INPUT: ${{ github.event.inputs.dryRun }}
          TIMEFRAMES_INPUT: ${{ github.event.inputs.timeframes }}
          SYNC_INPUT: ${{ github.event.inputs.sync }}
          HEALTH_INPUT: ${{ github.event.inputs.health }}
          PAPER_INPUT: ${{ github.event.inputs.paper }}
          ALERTS_INPUT: ${{ github.event.inputs.alerts }}
          ANALYTICS_INPUT: ${{ github.event.inputs.analytics }}
          TELEGRAM_INPUT: ${{ github.event.inputs.telegram }}
          FORCE_ALERTS_INPUT: ${{ github.event.inputs.forceAlerts }}
        run: |
          set -e

          SITE_URL="${SITE_URL_RAW%/}"

          DRY_RUN="${DRY_RUN_INPUT:-0}"
          TIMEFRAMES="${TIMEFRAMES_INPUT:-M15}"
          SYNC="${SYNC_INPUT:-1}"
          HEALTH="${HEALTH_INPUT:-1}"
          PAPER="${PAPER_INPUT:-1}"
          ALERTS="${ALERTS_INPUT:-1}"
          ANALYTICS="${ANALYTICS_INPUT:-1}"
          TELEGRAM="${TELEGRAM_INPUT:-1}"
          FORCE_ALERTS="${FORCE_ALERTS_INPUT:-0}"

          echo "SITE_URL=$SITE_URL" >> "$GITHUB_ENV"
          echo "SYNC_SECRET=$SYNC_SECRET" >> "$GITHUB_ENV"

          echo "DRY_RUN=$DRY_RUN" >> "$GITHUB_ENV"
          echo "TIMEFRAMES=$TIMEFRAMES" >> "$GITHUB_ENV"
          echo "SYNC=$SYNC" >> "$GITHUB_ENV"
          echo "HEALTH=$HEALTH" >> "$GITHUB_ENV"
          echo "PAPER=$PAPER" >> "$GITHUB_ENV"
          echo "ALERTS=$ALERTS" >> "$GITHUB_ENV"
          echo "ANALYTICS=$ANALYTICS" >> "$GITHUB_ENV"
          echo "TELEGRAM=$TELEGRAM" >> "$GITHUB_ENV"
          echo "FORCE_ALERTS=$FORCE_ALERTS" >> "$GITHUB_ENV"

          mkdir -p workflow-logs

          echo "Runtime config:"
          echo "SITE_URL=$SITE_URL"
          echo "TIMEFRAMES=$TIMEFRAMES"
          echo "DRY_RUN=$DRY_RUN"
          echo "SYNC=$SYNC"
          echo "HEALTH=$HEALTH"
          echo "PAPER=$PAPER"
          echo "ALERTS=$ALERTS"
          echo "ANALYTICS=$ANALYTICS"
          echo "TELEGRAM=$TELEGRAM"
          echo "FORCE_ALERTS=$FORCE_ALERTS"

      - name: Call server trading orchestrator
        run: |
          set -e

          SAFE_URL="$SITE_URL/api/server-trading?timeframes=$TIMEFRAMES&dryRun=$DRY_RUN&sync=$SYNC&health=$HEALTH&paper=$PAPER&alerts=$ALERTS&analytics=$ANALYTICS&telegram=$TELEGRAM&forceAlerts=$FORCE_ALERTS"

          FULL_URL="$SAFE_URL&token=$SYNC_SECRET"

          echo "Calling:"
          echo "$SAFE_URL"

          HTTP_STATUS=$(curl -sS \
            -o workflow-logs/server-trading-response.json \
            -w "%{http_code}" \
            "$FULL_URL")

          echo "$HTTP_STATUS" > workflow-logs/http-status.txt

          echo "HTTP_STATUS=$HTTP_STATUS"

          if [ ! -s workflow-logs/server-trading-response.json ]; then
            echo "❌ Empty response from server-trading"
            exit 1
          fi

          node <<'NODE'
          const fs = require("fs");

          const status = String(fs.readFileSync("workflow-logs/http-status.txt", "utf8")).trim();
          const raw = fs.readFileSync("workflow-logs/server-trading-response.json", "utf8");

          let data;

          try {
            data = JSON.parse(raw);
          } catch (error) {
            console.error("❌ Response is not valid JSON");
            console.error(raw.slice(0, 2000));
            process.exit(1);
          }

          const output = {
            httpStatus: Number(status),
            ok: data.ok,
            source: data.source,
            version: data.version,
            generatedAt: data.generatedAt,
            durationMs: data.durationMs,
            dryRun: data.dryRun,
            timeframes: data.timeframes,
            summary: data.summary
          };

          console.log(JSON.stringify(output, null, 2));

          const failed = Number(data?.summary?.failed || 0);

          if (Number(status) >= 400) {
            console.error("❌ HTTP error from server-trading");
            process.exit(1);
          }

          if (data.ok === false || failed > 0) {
            console.error("❌ Server trading reported failure");
            process.exit(1);
          }

          console.log("✅ Server trading completed successfully");
          NODE

      - name: Build compact report
        if: always()
        run: |
          node <<'NODE'
          const fs = require("fs");

          const file = "workflow-logs/server-trading-response.json";

          if (!fs.existsSync(file)) {
            console.log("No response file.");
            process.exit(0);
          }

          let data = {};

          try {
            data = JSON.parse(fs.readFileSync(file, "utf8"));
          } catch {
            console.log("Invalid JSON response.");
            process.exit(0);
          }

          const report = {
            ok: data.ok,
            generatedAt: data.generatedAt,
            durationMs: data.durationMs,
            summary: data.summary || {},
            health: (data.results?.health || []).map((item) => ({
              ok: item.ok,
              timeframe: item.data?.timeframe,
              freshPairs: item.data?.freshPairs,
              stalePairs: item.data?.stalePairs,
              missingPairs: item.data?.missingPairs,
              statusText: item.data?.statusText
            })),
            paper: (data.results?.paper || []).map((item) => ({
              ok: item.ok,
              timeframe: item.data?.timeframe,
              scannedPairs: item.data?.scannedPairs,
              opened: item.data?.opened,
              closed: item.data?.closed,
              topCandidates: Array.isArray(item.data?.topCandidates)
                ? item.data.topCandidates.slice(0, 5).map((candidate) => ({
                    pair: candidate.pair,
                    direction: candidate.direction,
                    paperScore: candidate.paperScore,
                    ultraScore: candidate.ultraScore,
                    tradeAllowed: candidate.tradeAllowed,
                    reason: candidate.tradeReason
                  }))
                : []
            })),
            alerts: data.results?.alerts
              ? {
                  ok: data.results.alerts.ok,
                  summary: data.results.alerts.data?.summary,
                  sent: data.results.alerts.data?.sent
                }
              : null
          };

          fs.writeFileSync("workflow-logs/compact-report.json", JSON.stringify(report, null, 2));

          console.log(JSON.stringify(report, null, 2));
          NODE

      - name: Upload workflow logs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: server-trading-workflow-logs
          path: workflow-logs/
          retention-days: 7
````

## File: .github/workflows/setup-alerts.yml
````yaml
name: Setup alerts

on:
  workflow_dispatch:
    inputs:
      timeframe:
        description: "M15, H1, H4"
        required: false
        default: "M15"
      dryRun:
        description: "1 = test sans Telegram, 0 = envoie Telegram"
        required: false
        default: "1"

  schedule:
    - cron: "3,18,33,48 * * * *"

jobs:
  setup-alerts:
    runs-on: ubuntu-latest

    steps:
      - name: Check secrets presence
        run: |
          if [ -z "${{ secrets.SITE_URL }}" ]; then
            echo "ERROR: SITE_URL missing"
            exit 1
          fi

          if [ -z "${{ secrets.SYNC_SECRET }}" ]; then
            echo "ERROR: SYNC_SECRET missing"
            exit 1
          fi

          echo "SITE_URL present"
          echo "SYNC_SECRET present"

      - name: Prepare variables
        id: vars
        shell: bash
        run: |
          SITE_URL="${{ secrets.SITE_URL }}"
          SITE_URL="${SITE_URL%/}"

          TIMEFRAME="${{ github.event.inputs.timeframe }}"
          DRY_RUN="${{ github.event.inputs.dryRun }}"

          if [ -z "$TIMEFRAME" ]; then
            TIMEFRAME="M15"
          fi

          if [ -z "$DRY_RUN" ]; then
            DRY_RUN="1"
          fi

          echo "site_url=$SITE_URL" >> "$GITHUB_OUTPUT"
          echo "timeframe=$TIMEFRAME" >> "$GITHUB_OUTPUT"
          echo "dry_run=$DRY_RUN" >> "$GITHUB_OUTPUT"

          echo "SITE_URL=$SITE_URL"
          echo "TIMEFRAME=$TIMEFRAME"
          echo "DRY_RUN=$DRY_RUN"

      - name: Run setup alerts
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/setup-alerts?token=${{ secrets.SYNC_SECRET }}&timeframe=${{ steps.vars.outputs.timeframe }}&dryRun=${{ steps.vars.outputs.dry_run }}"

          HTTP_CODE=$(curl -sS \
            -o setup_alerts.json \
            -w "%{http_code}" \
            "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat setup_alerts.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "setup-alerts HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('setup_alerts.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          SCANNED=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('setup_alerts.json','utf8')); console.log(j.scannedPairs ?? 0)")
          CANDIDATES=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('setup_alerts.json','utf8')); console.log(j.candidates ?? 0)")
          SENT=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('setup_alerts.json','utf8')); console.log(j.sent ?? 0)")

          echo "OK=$OK"
          echo "SCANNED=$SCANNED"
          echo "CANDIDATES=$CANDIDATES"
          echo "SENT=$SENT"

          if [ "$OK" != "true" ]; then
            echo "setup-alerts returned ok=false"
            exit 1
          fi

          if [ "$SCANNED" -le 0 ]; then
            echo "No pairs scanned"
            exit 1
          fi

      - name: Summary
        run: |
          echo "======================================"
          echo "SETUP ALERTS DONE"
          echo "Timeframe: ${{ steps.vars.outputs.timeframe }}"
          echo "Dry run: ${{ steps.vars.outputs.dry_run }}"
          echo "======================================"
````

## File: .github/workflows/smoke-test.yml
````yaml
name: API smoke test

on:
  workflow_dispatch:
    inputs:
      timeframe:
        description: "M15, H1, H4, M5"
        required: false
        default: "M15"

jobs:
  smoke-test:
    runs-on: ubuntu-latest

    steps:
      - name: Check secrets presence
        run: |
          if [ -z "${{ secrets.SITE_URL }}" ]; then
            echo "ERROR: SITE_URL missing"
            exit 1
          fi

          echo "SITE_URL present"

      - name: Prepare variables
        id: vars
        shell: bash
        run: |
          SITE_URL="${{ secrets.SITE_URL }}"
          SITE_URL="${SITE_URL%/}"

          TIMEFRAME="${{ github.event.inputs.timeframe }}"
          if [ -z "$TIMEFRAME" ]; then
            TIMEFRAME="M15"
          fi

          echo "site_url=$SITE_URL" >> "$GITHUB_OUTPUT"
          echo "timeframe=$TIMEFRAME" >> "$GITHUB_OUTPUT"

          echo "SITE_URL=$SITE_URL"
          echo "TIMEFRAME=$TIMEFRAME"

      - name: Test market data BTCUSD
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/market-data?pair=BTCUSD&timeframe=${{ steps.vars.outputs.timeframe }}&limit=50"

          HTTP_CODE=$(curl -sS -o btc.json -w "%{http_code}" "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat btc.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "BTC market-data HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('btc.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          PAIR=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('btc.json','utf8')); console.log(j.pair || '')")
          COUNT=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('btc.json','utf8')); console.log(j.count ?? 0)")

          echo "OK=$OK"
          echo "PAIR=$PAIR"
          echo "COUNT=$COUNT"

          if [ "$OK" != "true" ]; then
            echo "BTC market-data ok=false"
            exit 1
          fi

          if [ "$PAIR" != "BTCUSD" ]; then
            echo "BTC pair mismatch"
            exit 1
          fi

      - name: Test paper health
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/paper-health?timeframe=${{ steps.vars.outputs.timeframe }}"

          HTTP_CODE=$(curl -sS -o health.json -w "%{http_code}" "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat health.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "paper-health HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('health.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          TOTAL=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('health.json','utf8')); console.log(j.market?.totalPairs ?? 0)")
          FRESH=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('health.json','utf8')); console.log(j.market?.freshPairs ?? 0)")

          echo "OK=$OK"
          echo "TOTAL_PAIRS=$TOTAL"
          echo "FRESH_PAIRS=$FRESH"

          if [ "$OK" != "true" ]; then
            echo "paper-health ok=false"
            exit 1
          fi

          if [ "$TOTAL" -ne 26 ]; then
            echo "Expected 26 assets"
            exit 1
          fi

      - name: Test timeframe summary
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/timeframe-summary"

          HTTP_CODE=$(curl -sS -o mtf.json -w "%{http_code}" "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat mtf.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "timeframe-summary HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('mtf.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          HAS_BTC=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('mtf.json','utf8')); const rows=Object.values(j.summary||{}); const found=rows.some(x => (x.topAllowed||[]).some(p=>p.pair==='BTCUSD') || (x.topBlocked||[]).some(p=>p.pair==='BTCUSD') || x.best?.pair==='BTCUSD'); console.log(found ? 'true' : 'false')")

          echo "OK=$OK"
          echo "HAS_BTC=$HAS_BTC"

          if [ "$OK" != "true" ]; then
            echo "timeframe-summary ok=false"
            exit 1
          fi

      - name: Test correlation matrix
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/correlation-matrix?timeframe=${{ steps.vars.outputs.timeframe }}&limit=120"

          HTTP_CODE=$(curl -sS -o corr.json -w "%{http_code}" "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat corr.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "correlation-matrix HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('corr.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          HAS_BTC=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('corr.json','utf8')); console.log((j.pairs||[]).includes('BTCUSD') ? 'true' : 'false')")
          HAS_CLUSTER=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('corr.json','utf8')); console.log((j.clusters||[]).some(c=>c.name==='BTC_USD') ? 'true' : 'false')")

          echo "OK=$OK"
          echo "HAS_BTC=$HAS_BTC"
          echo "HAS_BTC_CLUSTER=$HAS_CLUSTER"

          if [ "$OK" != "true" ]; then
            echo "correlation-matrix ok=false"
            exit 1
          fi

      - name: Test archive stats BTCUSD
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/archive-stats?pair=BTCUSD&timeframe=${{ steps.vars.outputs.timeframe }}"

          HTTP_CODE=$(curl -sS -o archive.json -w "%{http_code}" "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat archive.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "archive-stats HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('archive.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          PAIR=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('archive.json','utf8')); console.log(j.pair || '')")

          echo "OK=$OK"
          echo "PAIR=$PAIR"

          if [ "$OK" != "true" ]; then
            echo "archive-stats ok=false"
            exit 1
          fi

          if [ "$PAIR" != "BTCUSD" ]; then
            echo "archive-stats pair mismatch"
            exit 1
          fi

      - name: Test ML BTCUSD
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/ml-score?pair=BTCUSD&timeframe=${{ steps.vars.outputs.timeframe }}&signal=BUY&ultraScore=78&trendScore=74&timingScore=70&riskScore=52&smartMoneyScore=65&executionScore=64&archiveEdgeScore=55&volatility=0.012&momentum=1.5&rr=2.1"

          HTTP_CODE=$(curl -sS -o ml.json -w "%{http_code}" "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat ml.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "ml-score HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('ml.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          SCORE=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('ml.json','utf8')); console.log(j.mlScore ?? 0)")

          echo "OK=$OK"
          echo "ML_SCORE=$SCORE"

          if [ "$OK" != "true" ]; then
            echo "ml-score ok=false"
            exit 1
          fi

      - name: Test VectorBT BTCUSD
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/vectorbt-score?pair=BTCUSD&timeframe=${{ steps.vars.outputs.timeframe }}&signal=BUY&ultraScore=78&trendScore=74&timingScore=70&riskScore=52&archiveEdgeScore=55&rr=2.1"

          HTTP_CODE=$(curl -sS -o vbt.json -w "%{http_code}" "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat vbt.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "vectorbt-score HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('vbt.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          SCORE=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('vbt.json','utf8')); console.log(j.vectorbtScore ?? 0)")

          echo "OK=$OK"
          echo "VECTORBT_SCORE=$SCORE"

          if [ "$OK" != "true" ]; then
            echo "vectorbt-score ok=false"
            exit 1
          fi

      - name: Test AI decision BTCUSD
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/ai-decision?pair=BTCUSD&timeframe=${{ steps.vars.outputs.timeframe }}&signal=BUY&tradeAllowed=true&ultraScore=82&mlScore=76&vectorbtScore=72&trendScore=78&timingScore=73&riskScore=54&archiveEdgeScore=58&mtfScore=78&mtfSignal=BUY&rr=2.1"

          HTTP_CODE=$(curl -sS -o ai.json -w "%{http_code}" "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat ai.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "ai-decision HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('ai.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          PAIR=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('ai.json','utf8')); console.log(j.pair || '')")
          DECISION=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('ai.json','utf8')); console.log(j.decision || '')")

          echo "OK=$OK"
          echo "PAIR=$PAIR"
          echo "DECISION=$DECISION"

          if [ "$OK" != "true" ]; then
            echo "ai-decision ok=false"
            exit 1
          fi

          if [ "$PAIR" != "BTCUSD" ]; then
            echo "ai-decision pair mismatch"
            exit 1
          fi

      - name: Test exit engine BTCUSD
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/exit-engine?pair=BTCUSD&timeframe=${{ steps.vars.outputs.timeframe }}&signal=BUY&ultraScore=80&trendScore=76&timingScore=70&riskScore=52&executionScore=64&smartMoneyScore=65&archiveEdgeScore=55&mtfScore=75&mtfSignal=BUY&volatility=0.012"

          HTTP_CODE=$(curl -sS -o exit.json -w "%{http_code}" "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat exit.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "exit-engine HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('exit.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          PAIR=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('exit.json','utf8')); console.log(j.pair || '')")
          ACTION=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('exit.json','utf8')); console.log(j.exitAction || '')")

          echo "OK=$OK"
          echo "PAIR=$PAIR"
          echo "EXIT_ACTION=$ACTION"

          if [ "$OK" != "true" ]; then
            echo "exit-engine ok=false"
            exit 1
          fi

          if [ "$PAIR" != "BTCUSD" ]; then
            echo "exit-engine pair mismatch"
            exit 1
          fi

      - name: Test portfolio risk BTCUSD
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/portfolio-risk"

          cat > payload.json <<'JSON'
          {
            "positions": [
              { "pair": "BTCUSD", "riskPercent": 0.5 },
              { "pair": "EURUSD", "riskPercent": 0.5 },
              { "pair": "XAUUSD", "riskPercent": 0.5 }
            ]
          }
          JSON

          HTTP_CODE=$(curl -sS \
            -o portfolio.json \
            -w "%{http_code}" \
            -H "Content-Type: application/json" \
            -d @payload.json \
            "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat portfolio.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "portfolio-risk HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('portfolio.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          HAS_CRYPTO=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('portfolio.json','utf8')); console.log(j.cryptoExposure?.name === 'BTC_USD' ? 'true' : 'false')")

          echo "OK=$OK"
          echo "HAS_CRYPTO=$HAS_CRYPTO"

          if [ "$OK" != "true" ]; then
            echo "portfolio-risk ok=false"
            exit 1
          fi

          if [ "$HAS_CRYPTO" != "true" ]; then
            echo "BTC crypto exposure missing"
            exit 1
          fi

      - name: Test paper trades
        shell: bash
        run: |
          URL="${{ steps.vars.outputs.site_url }}/api/paper-trades?pair=BTCUSD&timeframe=${{ steps.vars.outputs.timeframe }}&limit=20"

          HTTP_CODE=$(curl -sS -o paper.json -w "%{http_code}" "$URL")

          echo "HTTP_CODE=$HTTP_CODE"
          cat paper.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "paper-trades HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('paper.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")

          echo "OK=$OK"

          if [ "$OK" != "true" ]; then
            echo "paper-trades ok=false"
            exit 1
          fi

      - name: Final summary
        run: |
          echo "======================================"
          echo "API SMOKE TEST PASSED"
          echo "BTCUSD integration is active"
          echo "Timeframe: ${{ steps.vars.outputs.timeframe }}"
          echo "======================================"
````

## File: .github/workflows/sync-all-market.yml
````yaml
name: Sync all market candles

on:
  workflow_dispatch:
    inputs:
      timeframe:
        description: "M15, H1, H4, M5, or ALL"
        required: false
        default: "ALL"
      delay_seconds:
        description: "Delay between API calls"
        required: false
        default: "12"

jobs:
  sync-all-market:
    runs-on: ubuntu-latest

    steps:
      - name: Check secrets presence
        run: |
          if [ -z "${{ secrets.SITE_URL }}" ]; then
            echo "ERROR: SITE_URL missing"
            exit 1
          fi

          if [ -z "${{ secrets.SYNC_SECRET }}" ]; then
            echo "ERROR: SYNC_SECRET missing"
            exit 1
          fi

          echo "SITE_URL present"
          echo "SYNC_SECRET present"

      - name: Sync all groups
        shell: bash
        run: |
          INPUT_TIMEFRAME="${{ github.event.inputs.timeframe }}"
          DELAY="${{ github.event.inputs.delay_seconds }}"

          if [ -z "$INPUT_TIMEFRAME" ]; then
            INPUT_TIMEFRAME="ALL"
          fi

          if [ -z "$DELAY" ]; then
            DELAY="12"
          fi

          if [ "$INPUT_TIMEFRAME" = "ALL" ]; then
            TIMEFRAMES=("M15" "H1" "H4")
          else
            TIMEFRAMES=("$INPUT_TIMEFRAME")
          fi

          TOTAL_INSERTED=0
          TOTAL_FAILED=0
          TOTAL_CALLS=0

          for TF in "${TIMEFRAMES[@]}"; do
            echo "========================================"
            echo "SYNC TIMEFRAME: $TF"
            echo "========================================"

            for GROUP in 1 2 3 4 5 6 7 8 9 10 11; do
              echo "Syncing timeframe=$TF group=$GROUP"

              HTTP_CODE=$(curl -sS \
                -o "response_${TF}_${GROUP}.json" \
                -w "%{http_code}" \
                "${{ secrets.SITE_URL }}/api/sync-market?token=${{ secrets.SYNC_SECRET }}&timeframe=${TF}&group=${GROUP}")

              echo "HTTP_CODE=$HTTP_CODE"
              cat "response_${TF}_${GROUP}.json" || true
              echo ""

              if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
                echo "sync-market HTTP error on timeframe=$TF group=$GROUP"
                exit 1
              fi

              OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response_${TF}_${GROUP}.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
              INSERTED=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response_${TF}_${GROUP}.json','utf8')); console.log(j.inserted ?? 0)")
              FAILED=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response_${TF}_${GROUP}.json','utf8')); console.log(j.failed ?? 0)")
              REQUESTED=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response_${TF}_${GROUP}.json','utf8')); console.log(j.requestedPairs ?? 0)")

              echo "OK=$OK"
              echo "INSERTED=$INSERTED"
              echo "FAILED=$FAILED"
              echo "REQUESTED_PAIRS=$REQUESTED"

              TOTAL_CALLS=$((TOTAL_CALLS + 1))
              TOTAL_INSERTED=$((TOTAL_INSERTED + INSERTED))
              TOTAL_FAILED=$((TOTAL_FAILED + FAILED))

              if [ "$OK" != "true" ]; then
                echo "sync-market returned ok=false on timeframe=$TF group=$GROUP"
                exit 1
              fi

              sleep "$DELAY"
            done
          done

          echo "========================================"
          echo "SYNC COMPLETE"
          echo "TOTAL_CALLS=$TOTAL_CALLS"
          echo "TOTAL_INSERTED=$TOTAL_INSERTED"
          echo "TOTAL_FAILED=$TOTAL_FAILED"
          echo "========================================"

          if [ "$TOTAL_INSERTED" -le 0 ]; then
            echo "No candles inserted"
            exit 1
          fi

          if [ "$TOTAL_FAILED" -gt 0 ]; then
            echo "Some sync calls failed"
            exit 1
          fi

      - name: Check M15 paper health
        run: |
          HTTP_CODE=$(curl -sS \
            -o health_m15.json \
            -w "%{http_code}" \
            "${{ secrets.SITE_URL }}/api/paper-health?timeframe=M15")

          echo "HTTP_CODE=$HTTP_CODE"
          cat health_m15.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "paper-health M15 HTTP error"
            exit 1
          fi

      - name: Check BTC market data
        run: |
          HTTP_CODE=$(curl -sS \
            -o btc_m15.json \
            -w "%{http_code}" \
            "${{ secrets.SITE_URL }}/api/market-data?pair=BTCUSD&timeframe=M15&limit=50")

          echo "HTTP_CODE=$HTTP_CODE"
          cat btc_m15.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "BTC market-data HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('btc_m15.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          COUNT=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('btc_m15.json','utf8')); console.log(j.count ?? 0)")

          echo "OK=$OK"
          echo "BTC_M15_COUNT=$COUNT"

          if [ "$OK" != "true" ]; then
            echo "BTC market-data returned ok=false"
            exit 1
          fi

          if [ "$COUNT" -le 0 ]; then
            echo "BTCUSD has no M15 candles"
            exit 1
          fi
````

## File: .github/workflows/sync-market.yml
````yaml
name: Sync market candles

on:
  workflow_dispatch:
    inputs:
      timeframe:
        description: "M5, M15, H1, H4, or AUTO"
        required: false
        default: "AUTO"
      group:
        description: "1 to 11, or AUTO"
        required: false
        default: "AUTO"

  schedule:
    - cron: "*/15 * * * *"

jobs:
  sync-market:
    runs-on: ubuntu-latest

    steps:
      - name: Check secrets presence
        run: |
          if [ -z "${{ secrets.SITE_URL }}" ]; then
            echo "ERROR: SITE_URL missing"
            exit 1
          fi

          if [ -z "${{ secrets.SYNC_SECRET }}" ]; then
            echo "ERROR: SYNC_SECRET missing"
            exit 1
          fi

          echo "SITE_URL present"
          echo "SYNC_SECRET present"

      - name: Compute sync timeframe and group
        id: vars
        shell: bash
        run: |
          MANUAL_TIMEFRAME="${{ github.event.inputs.timeframe }}"
          MANUAL_GROUP="${{ github.event.inputs.group }}"

          SLOT=$(( $(date -u +%s) / 900 ))

          if [ -n "$MANUAL_TIMEFRAME" ] && [ "$MANUAL_TIMEFRAME" != "AUTO" ]; then
            TIMEFRAME="$MANUAL_TIMEFRAME"
          else
            MOD=$(( SLOT % 16 ))

            if [ "$MOD" -eq 0 ]; then
              TIMEFRAME="H4"
            elif [ "$MOD" -eq 4 ] || [ "$MOD" -eq 8 ] || [ "$MOD" -eq 12 ]; then
              TIMEFRAME="H1"
            else
              TIMEFRAME="M15"
            fi
          fi

          if [ -n "$MANUAL_GROUP" ] && [ "$MANUAL_GROUP" != "AUTO" ]; then
            GROUP="$MANUAL_GROUP"
          else
            GROUP=$(( (SLOT % 11) + 1 ))
          fi

          echo "timeframe=$TIMEFRAME" >> "$GITHUB_OUTPUT"
          echo "group=$GROUP" >> "$GITHUB_OUTPUT"

          echo "Using timeframe $TIMEFRAME"
          echo "Using group $GROUP"

      - name: Sync market group
        run: |
          HTTP_CODE=$(curl -sS \
            -o response.json \
            -w "%{http_code}" \
            "${{ secrets.SITE_URL }}/api/sync-market?token=${{ secrets.SYNC_SECRET }}&timeframe=${{ steps.vars.outputs.timeframe }}&group=${{ steps.vars.outputs.group }}")

          echo "HTTP_CODE=$HTTP_CODE"
          cat response.json || true

          if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "sync-market HTTP error"
            exit 1
          fi

          OK=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response.json','utf8')); console.log(j.ok === true ? 'true' : 'false')")
          INSERTED=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response.json','utf8')); console.log(j.inserted ?? 0)")
          FAILED=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response.json','utf8')); console.log(j.failed ?? 0)")
          REQUESTED=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('response.json','utf8')); console.log(j.requestedPairs ?? 0)")

          echo "OK=$OK"
          echo "INSERTED=$INSERTED"
          echo "FAILED=$FAILED"
          echo "REQUESTED_PAIRS=$REQUESTED"

          if [ "$OK" != "true" ]; then
            echo "sync-market returned ok=false"
            exit 1
          fi

          if [ "$INSERTED" -le 0 ]; then
            echo "No candles inserted"
            exit 1
          fi
````

## File: .github/workflows/validate-code.yml
````yaml
name: Validate code

on:
  workflow_dispatch:
  pull_request:
  push:
    branches:
      - main

jobs:
  validate-code:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Validate JavaScript syntax
        shell: bash
        run: |
          echo "Checking JS syntax..."

          FILES=$(find . \
            -type f \
            -name "*.js" \
            -not -path "./node_modules/*" \
            -not -path "./.git/*")

          if [ -z "$FILES" ]; then
            echo "No JS files found"
            exit 1
          fi

          for FILE in $FILES; do
            echo "Checking $FILE"
            node --input-type=module --check < "$FILE"
          done

          echo "JS syntax OK"

      - name: Validate required files
        shell: bash
        run: |
          REQUIRED_FILES=(
            "index.html"
            "styles.css"
            "config.js"
            "state.js"
            "api.js"
            "app.js"
            "render.js"
            "scan.js"
            "trades.js"
            "paper-engine.js"
            "utils.js"
            "functions/api/market-data.js"
            "functions/api/sync-market.js"
            "functions/api/paper-run.js"
            "functions/api/paper-health.js"
            "functions/api/paper-trades.js"
            "functions/api/timeframe-summary.js"
            "functions/api/archive-stats.js"
            "functions/api/correlation-matrix.js"
            "functions/api/portfolio-risk.js"
            "functions/api/ml-score.js"
            "functions/api/vectorbt-score.js"
            "functions/api/ai-decision.js"
            "functions/api/exit-engine.js"
          )

          for FILE in "${REQUIRED_FILES[@]}"; do
            if [ ! -f "$FILE" ]; then
              echo "Missing required file: $FILE"
              exit 1
            fi
          done

          echo "Required files OK"

      - name: Check BTCUSD integration
        shell: bash
        run: |
          REQUIRED_BTC_FILES=(
            "config.js"
            "scan.js"
            "utils.js"
            "render.js"
            "trades.js"
            "paper-engine.js"
            "state.js"
            "functions/api/market-data.js"
            "functions/api/sync-market.js"
            "functions/api/paper-run.js"
            "functions/api/paper-health.js"
            "functions/api/paper-trades.js"
            "functions/api/timeframe-summary.js"
            "functions/api/archive-stats.js"
            "functions/api/correlation-matrix.js"
            "functions/api/portfolio-risk.js"
            "functions/api/ml-score.js"
            "functions/api/vectorbt-score.js"
            "functions/api/ai-decision.js"
            "functions/api/exit-engine.js"
          )

          for FILE in "${REQUIRED_BTC_FILES[@]}"; do
            if ! grep -q "BTCUSD" "$FILE"; then
              echo "BTCUSD missing in $FILE"
              exit 1
            fi
          done

          echo "BTCUSD integration OK"

      - name: Check asset count text
        shell: bash
        run: |
          if grep -q "25 assets" index.html; then
            echo "Old asset count found in index.html: 25 assets"
            exit 1
          fi

          if ! grep -q "26 assets" index.html; then
            echo "index.html should display 26 assets"
            exit 1
          fi

          echo "Asset count OK"

      - name: Check workflow files
        shell: bash
        run: |
          REQUIRED_WORKFLOWS=(
            ".github/workflows/sync-market.yml"
            ".github/workflows/paper-run.yml"
            ".github/workflows/sync-all-market.yml"
            ".github/workflows/smoke-test.yml"
          )

          for FILE in "${REQUIRED_WORKFLOWS[@]}"; do
            if [ ! -f "$FILE" ]; then
              echo "Missing workflow: $FILE"
              exit 1
            fi
          done

          echo "Workflow files OK"

      - name: Final summary
        run: |
          echo "======================================"
          echo "CODE VALIDATION PASSED"
          echo "JS syntax OK"
          echo "BTCUSD integration OK"
          echo "Required files OK"
          echo "======================================"
````

## File: .serena/project.yml
````yaml
project_name: "FTMO"
language_servers:
  - typescript
  - python
ls_workspace_folders:
  - "."
ignore_all_files_in_gitignore: true
ignored_paths:
  - "**/node_modules/**"
  - "**/.venv/**"
  - "**/__pycache__/**"
  - "**/dist/**"
  - "**/build/**"
read_only: false
encoding: utf-8
symbol_info_budget: 8
initial_prompt: |
  Use Serena's symbol and reference tools before reading whole files. Start with symbol overviews, find_symbol and find_referencing_symbols; fetch full file bodies only when required for the task. Prefer targeted edits and preserve the existing architecture.
````

## File: backtesting/vectorbt_service.py
````python
app = FastAPI(title="FTMO Edge VectorBT Advanced Service")
⋮----
class Candle(BaseModel)
⋮----
time: int
open: float
high: float
low: float
close: float
⋮----
class BacktestPayload(BaseModel)
⋮----
pair: str
timeframe: str
candles: List[Candle]
fee: float = 0.0002
slippage: float = 0.0001
⋮----
fast_ema: int = 20
slow_ema: int = 50
rsi_period: int = 14
atr_period: int = 14
⋮----
rsi_buy_min: float = 45
rsi_buy_max: float = 65
rsi_sell_min: float = 35
rsi_sell_max: float = 55
⋮----
stop_atr_mult: float = 1.4
take_atr_mult: float = 2.6
⋮----
def build_dataframe(candles: List[Candle]) -> pd.DataFrame
⋮----
df = pd.DataFrame([c.model_dump() for c in candles])
⋮----
df = df.set_index("datetime").sort_index()
⋮----
df = df.dropna()
⋮----
def ema(series: pd.Series, period: int) -> pd.Series
⋮----
def rsi(series: pd.Series, period: int = 14) -> pd.Series
⋮----
delta = series.diff()
gain = delta.clip(lower=0)
loss = -delta.clip(upper=0)
⋮----
avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
⋮----
rs = avg_gain / avg_loss.replace(0, np.nan)
out = 100 - (100 / (1 + rs))
⋮----
def atr(df: pd.DataFrame, period: int = 14) -> pd.Series
⋮----
prev_close = df["close"].shift(1)
tr = pd.concat([
⋮----
def macd_hist(series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.Series
⋮----
macd_line = ema(series, fast) - ema(series, slow)
signal_line = macd_line.ewm(span=signal, adjust=False).mean()
⋮----
def add_indicators(df: pd.DataFrame, payload: BacktestPayload) -> pd.DataFrame
⋮----
def build_long_signals(df: pd.DataFrame, payload: BacktestPayload)
⋮----
trend_ok = df["ema_fast"] > df["ema_slow"]
rsi_ok = (df["rsi"] >= payload.rsi_buy_min) & (df["rsi"] <= payload.rsi_buy_max)
macd_ok = df["macd_hist"] > 0
structure_ok = df["close"] > df["rolling_mid_20"]
⋮----
entries = trend_ok & rsi_ok & macd_ok & structure_ok
exits = (
⋮----
def build_short_signals(df: pd.DataFrame, payload: BacktestPayload)
⋮----
trend_ok = df["ema_fast"] < df["ema_slow"]
rsi_ok = (df["rsi"] >= payload.rsi_sell_min) & (df["rsi"] <= payload.rsi_sell_max)
macd_ok = df["macd_hist"] < 0
structure_ok = df["close"] < df["rolling_mid_20"]
⋮----
def portfolio_stats_to_dict(stats: pd.Series) -> Dict[str, Any]
⋮----
def f(key: str, default=0.0)
⋮----
val = stats.get(key, default)
⋮----
def i(key: str, default=0)
⋮----
total_return = f("Total Return [%]")
win_rate = f("Win Rate [%]")
max_drawdown = abs(f("Max Drawdown [%]"))
total_trades = i("Total Trades")
profit_factor = f("Profit Factor")
sharpe = f("Sharpe Ratio")
calmar = f("Calmar Ratio")
expectancy = total_return / total_trades if total_trades > 0 else 0.0
⋮----
def compute_vectorbt_score(metrics: Dict[str, Any]) -> int
⋮----
score = 50.0
⋮----
total_return = metrics["totalReturnPct"]
win_rate = metrics["winRatePct"]
max_drawdown = metrics["maxDrawdownPct"]
total_trades = metrics["totalTrades"]
profit_factor = metrics["profitFactor"]
sharpe = metrics["sharpeRatio"]
calmar = metrics["calmarRatio"]
⋮----
def confidence_band(score: int) -> str
⋮----
def choose_best_side(long_metrics: Dict[str, Any], short_metrics: Dict[str, Any])
⋮----
long_score = compute_vectorbt_score(long_metrics)
short_score = compute_vectorbt_score(short_metrics)
⋮----
@app.get("/")
def root()
⋮----
@app.get("/health")
def health()
⋮----
@app.post("/backtest")
def run_backtest(payload: BacktestPayload)
⋮----
df = build_dataframe(payload.candles)
df = add_indicators(df, payload)
⋮----
close = df["close"]
⋮----
pf_long = vbt.Portfolio.from_signals(
⋮----
pf_short = vbt.Portfolio.from_signals(
⋮----
long_stats = portfolio_stats_to_dict(pf_long.stats())
short_stats = portfolio_stats_to_dict(pf_short.stats())
⋮----
explanation = (
````

## File: functions/_shared/archive-intelligence.js
````javascript
export async function ensureArchiveColumns(db)
⋮----
// Column already exists or table is not ready yet.
⋮----
export async function getArchiveStatsMap(db, timeframe = "M15", pairs = DEFAULT_PAIRS)
⋮----
export async function buildHistoricalEdgeGate(db, scan =
⋮----
export async function buildArchiveIntelligence(db, filters =
⋮----
async function queryStats(db, columns, filters =
⋮----
async function groupStats(db, columns, groupBy, filters =
⋮----
function buildWhere(columns, filters =
⋮----
async function getTableColumns(db, tableName)
⋮----
function normalizeStats(row, columns)
⋮----
function emptyStats()
⋮----
function computeHistoricalEdgeScore(data)
⋮----
function scoreStats(stats, weight)
⋮----
function computeConfidence(data)
⋮----
function pickBest(rows)
⋮----
function toFrontendArchiveStats(pair, intelligence)
⋮----
function getGateProfile(pair, mode)
⋮----
function inferSession(date = new Date())
⋮----
function inferHour(date = new Date())
⋮----
function round(value, digits = 2)
⋮----
function clamp(value, min = 1, max = 99)
````

## File: functions/_shared/ftmo-guardian.js
````javascript
export async function applyFtmoGuardianToScans(db, scans, options =
⋮----
export async function evaluateFtmoTrade(db, scan, options =
⋮----
export async function buildGuardianContext(db, account, timeframe = "M15")
⋮----
export function buildAccountConfig(env =
⋮----
async function ensureFtmoGuardianTables(db)
⋮----
async function getOrCreateDailyAnchor(db, account, dateKey, timeframe)
⋮----
async function getTotalClosedPnl(db)
⋮----
async function getClosedStats(db, dateKey)
⋮----
async function getConsecutiveLosses(db)
⋮----
async function getOpenTrades(db, timeframe)
⋮----
async function valueOpenTrades(db, openTrades, timeframe, account)
⋮----
async function getCurrentPrice(db, pair, timeframe)
⋮----
function normalizeCandidate(scan, account)
⋮----
function estimateRiskPercentFromScore(scan, account)
⋮----
function computeGuardianRiskPercent(data)
⋮----
function computeStatus(data)
⋮----
function buildCurrencyExposure(valuedTrades)
⋮----
function computeCandidateExposure(currentExposure, trade)
⋮----
function buildAllowedReason(context, trade, recommendedRiskPercent, warnings)
⋮----
function getPairRiskGroups(pair)
⋮----
function getPhaseDefaults(phase)
⋮----
function readNumber(primary, secondary, fallback)
⋮----
function getParisDateKey(date = new Date())
⋮----
function normalizeTimeframe(value)
⋮----
function percentOf(value, total)
⋮----
function roundByPair(value, pair)
⋮----
function round(value, digits = 2)
⋮----
function money(value)
````

## File: functions/_shared/model-rules.js
````javascript
export async function applyModelRulesToScans(db, scans = [], options =
⋮----
export async function loadModelRules(db, config = DEFAULT_CONFIG)
⋮----
export async function ensureModelRulesTable(db)
⋮----
function applyRulesToSingleScan(scan, rules, config)
⋮----
function ruleMatchesScan(rule, scan)
⋮----
function computeRuleImpact(rule, config)
⋮----
function normalizeRule(row)
⋮----
function parsePayload(value)
⋮----
function formatRuleSummary(reasons)
⋮----
function getScoreBucket(score)
⋮----
function normalizePair(value)
⋮----
function normalizeText(value)
⋮----
function normalizeTarget(value)
⋮----
function inferHour(date = new Date())
⋮----
function clampScore(value)
⋮----
function clamp(value, min, max)
````

## File: functions/_shared/news-filter.js
````javascript
export async function applyNewsFilterToScans(db, scans, options =
⋮----
export async function evaluateNewsRisk(db, scan, options =
⋮----
export async function ensureNewsTables(db)
⋮----
async function addColumnIfMissing(db, table, column, type)
⋮----
// Column already exists.
⋮----
export async function insertNewsEvent(db, event)
⋮----
export async function listNewsEvents(db, options =
⋮----
async function getRelevantNewsEvents(db, env, now)
⋮----
function parseEnvNewsEvents(env =
⋮----
function evaluateNewsRiskForScan(scan, events, now)
⋮----
function normalizeDbEvent(row)
⋮----
function getPairCurrencies(pair)
⋮----
function isEventRelevantForPair(event, currencies, pair)
⋮----
function isHighImpact(event)
⋮----
function getDefaultBeforeMinutes(impact, title = "")
⋮----
function getDefaultAfterMinutes(impact, title = "")
⋮----
function isKeywordHighRisk(title = "")
⋮----
function normalizeImpact(value)
⋮----
function normalizeCurrency(value)
````

## File: functions/_shared/realistic-execution.js
````javascript
export function buildRealisticEntry(scan, options =
⋮----
export function buildRealisticExit(trade, rawExitPrice, options =
⋮----
export function getExecutionProfile(pair, env =
⋮----
export function estimateExecutionPenaltyR(pair, riskDistance, env =
⋮----
function computePnlR(trade, exitPrice)
⋮----
function getOriginalRiskDistance(trade)
⋮----
function getFallbackRiskDistance(pair, current)
⋮----
function getPipSize(pair)
⋮----
function getDefaultRr(pair)
⋮----
function normalizePair(pair)
⋮----
function roundByPair(value, pair)
⋮----
function round(value, digits = 2)
````

## File: functions/api/ai-decision.js
````javascript
export async function onRequestPost(context)
⋮----
export async function onRequestGet(context)
⋮----
function normalizeScan(input)
⋮----
function buildDecision(scan)
⋮----
function computeDecisionScore(scan, profile)
⋮----
function getBlockers(scan, profile, score)
⋮----
function buildTitle(scan, decision, score, blockers)
⋮----
function buildReason(scan, decision, score, blockers, profile)
⋮----
function buildRiskMode(scan, profile, score)
⋮----
function buildBadge(decision, score, profile)
⋮----
function buildNotes(scan, decision, score, profile, blockers)
⋮----
function getPairProfile(pair)
⋮----
function getDefaultRr(pair)
⋮----
function getTradingWindow(timeframe, pair)
⋮----
function getModelBias(decision, score)
⋮----
function getPairLabel(pair)
⋮----
function normalizeTimeframe(value)
⋮----
async function safeJson(request)
⋮----
function safeNumber(value, fallback = 0)
⋮----
function round(value, digits = 2)
⋮----
function clamp(value, min = 1, max = 99)
⋮----
function json(data, status = 200)
````

## File: functions/api/analytics-engine.js
````javascript
export async function onRequestGet(context)
⋮----
export async function onRequestPost(context)
⋮----
async function handleAnalytics(context)
⋮----
async function ensureAnalyticsTables(db)
⋮----
async function importPaperTradesIntoLearning(db)
⋮----
// No paper_trades yet.
⋮----
async function computeOverallStats(db)
⋮----
async function computeGroupedStats(db, field, minTrades)
⋮----
async function computePairDirectionStats(db, minTrades)
⋮----
async function computeScoreBuckets(db, minTrades)
⋮----
async function getLearningRows(db)
⋮----
function buildStats(type, key, rows)
⋮----
function buildRecommendations(data)
⋮----
async function saveAnalyticsSnapshot(db, payload)
⋮----
function scoreStats(data)
⋮----
function sortStats(a, b)
⋮----
function confidenceFromTrades(trades)
⋮----
function maxDrawdown(values)
⋮----
function normalizePair(pair)
⋮----
function inferSession(value)
⋮----
function inferHour(value)
⋮----
function average(values)
⋮----
function percent(a, b)
⋮----
function round(value, digits = 2)
⋮----
function clamp(value, min, max)
⋮----
function isAuthorized(request, secret)
⋮----
function json(data, status = 200)
````

## File: functions/api/archive-stats.js
````javascript
export async function onRequestGet(context)
⋮----
function normalizeDirections(rows)
⋮----
function normalizePair(value)
⋮----
function normalizeTimeframe(value)
⋮----
function normalizeDirection(value)
⋮----
function cleanText(value)
⋮----
function json(data, status = 200)
````

## File: functions/api/correlation-matrix.js
````javascript
export async function onRequestPost(context)
⋮----
export async function onRequestGet(context)
⋮----
async function getCandles(db, pair, timeframe, limit)
⋮----
function normalizeInputRow(row)
⋮----
function buildCorrelationMatrix(rows)
⋮----
function buildCorrelationAlerts(pairs, matrix)
⋮----
function buildRiskClusters(rows, matrix)
⋮----
function pushCluster(clusters, name, clusterPairs, allPairs, matrix)
⋮----
function computeClusterAverageAbsCorrelation(clusterPairs, allPairs, matrix)
⋮----
function getCorrelationRiskType(pairA, pairB, corr)
⋮----
function toReturns(values)
⋮----
function pearson(a, b)
⋮----
function average(values)
⋮----
function normalizePair(value)
⋮----
function normalizeTimeframe(value)
⋮----
function normalizeLimit(value)
⋮----
async function safeJson(request)
⋮----
function round(value, digits = 3)
⋮----
function json(data, status = 200)
````

## File: functions/api/exit-engine.js
````javascript
export async function onRequestPost(context)
⋮----
export async function onRequestGet(context)
⋮----
function normalizeScan(input)
⋮----
function normalizeAi(input)
⋮----
function buildExitDecision(scan, ai)
⋮----
function computeExitPressure(scan, ai, profile)
⋮----
function scoreWeakness(score, weakLevel)
⋮----
function computeProtectionMode(scan, profile)
⋮----
function getExitAction(exitPressure, scan, ai, profile)
⋮----
function buildComment(exitAction, exitPressure, scan, ai, profile)
⋮----
function buildNotes(exitAction, scan, profile)
⋮----
function getPairProfile(pair)
⋮----
function getDefaultRr(pair)
⋮----
function normalizeTimeframe(value)
⋮----
async function safeJson(request)
⋮----
function safeNumber(value, fallback = 0)
⋮----
function round(value, digits = 2)
⋮----
function clamp(value, min = 1, max = 99)
⋮----
function json(data, status = 200)
````

## File: functions/api/ftmo-status.js
````javascript
export async function onRequestGet(context)
⋮----
export async function onRequestPost(context)
⋮----
async function handleFtmoStatus(context)
⋮----
async function ensureFtmoStatusTables(db)
⋮----
async function addColumnIfMissing(db, table, column, type)
⋮----
// Column already exists.
⋮----
function buildAccountOverrides(url, body)
⋮----
function readParam(url, body, key)
⋮----
function computeRecommendedRiskPercent(data)
⋮----
function buildDangerReport(data)
⋮----
function computeFtmoHealthScore(data)
⋮----
async function saveStatusSnapshot(db, snapshot)
⋮----
// Snapshot is optional.
⋮----
function normalizeTimeframe(value)
⋮----
function percentOf(value, total)
⋮----
function round(value, digits = 2)
⋮----
function clamp(value, min = 0, max = 100)
⋮----
function isAuthorized(request, secret)
⋮----
async function safeJson(request)
⋮----
function json(data, status = 200)
````

## File: functions/api/health.js
````javascript
export async function onRequestGet(context)
````

## File: functions/api/import-market-csv.js
````javascript
export async function onRequestGet(context)
⋮----
export async function onRequestPost(context)
⋮----
async function parseIncomingRequest(request)
⋮----
async function insertRows(db, rows)
⋮----
function parseCsv(raw, pair, timeframe)
⋮----
function parseRowParts(parts)
⋮----
function splitCsvLine(line, delimiter)
⋮----
function detectDelimiter(line)
⋮----
function stripQuotes(value)
⋮----
function looksLikeIsoDateTime(value)
⋮----
function toUnixFromAnyDateTime(value)
⋮----
function containsDateTime(value)
⋮----
function splitDateTimeFlexible(value)
⋮----
function stripMilliseconds(value)
⋮----
function stripTimezone(value)
⋮----
function normalizeUnixTs(value)
⋮----
function isNumeric(value)
⋮----
function looksLikeDate(value)
⋮----
function looksLikeTime(value)
⋮----
function looksLikeHeader(line)
⋮----
function toUnix(datePart, timePart)
⋮----
function normalizeDate(value)
⋮----
function normalizeTime(value)
⋮----
function toNum(value)
⋮----
function dedupeRows(rows)
⋮----
function cleanPair(value)
⋮----
function normalizeTimeframe(value)
⋮----
function json(data, status = 200)
````

## File: functions/api/journal-insights.js
````javascript
export async function onRequestPost(context)
⋮----
function normalizeTrade(trade)
⋮----
function computePnl(trade)
⋮----
function aggregateBy(items, keyFn)
⋮----
function buildInsights(data)
⋮----
function getSessionLabel(hour)
⋮----
function maxBy(items, key)
⋮----
function minBy(items, key)
⋮----
function safeDate(value)
⋮----
function round(value, decimals = 2)
⋮----
function cleanText(value, fallback)
⋮----
async function safeJson(request)
⋮----
function json(data, status = 200)
````

## File: functions/api/macro-context.js
````javascript
export async function onRequestGet(context)
⋮----
function buildEconomicEvents(now)
⋮----
function isRelevantForPair(currency, pair)
⋮----
function cleanPair(value)
⋮----
function clampInt(value, min, max, fallback)
⋮----
function json(data, status = 200)
````

## File: functions/api/macro-feed.js
````javascript
export async function onRequestGet(context)
⋮----
function normalizeFmpEvent(item)
⋮----
function normalizeImpact(value)
⋮----
function buildFallbackEvents(now)
⋮----
function event(name, date, currency, impact)
⋮----
function addDays(date, days)
⋮----
function formatDate(date)
⋮----
function json(data, status = 200)
````

## File: functions/api/market-data.js
````javascript
export async function onRequestGet(context)
⋮----
async function getCandles(db, pair, timeframe, limit)
⋮----
function normalizePair(value)
⋮----
function normalizeTimeframe(value)
⋮----
function normalizeLimit(value)
⋮----
function roundByPair(value, pair)
⋮----
function json(data, status = 200)
````

## File: functions/api/ml-score.js
````javascript
export async function onRequestPost(context)
⋮----
export async function onRequestGet(context)
⋮----
function normalizeScan(input)
⋮----
function scoreMl(scan)
⋮----
function getPairProfile(pair)
⋮----
function getTimeframeBoost(timeframe)
⋮----
function scoreDirectionQuality(scan)
⋮----
function scoreMomentum(scan, profile)
⋮----
function scoreVolatility(scan, profile)
⋮----
function scoreRsi(scan)
⋮----
function scoreConfluence(scan)
⋮----
function scoreArchive(scan)
⋮----
function applyBtcAdjustment(scan, score)
⋮----
function applyGoldAdjustment(scan, score)
⋮----
function getConfidenceBand(score, scan)
⋮----
function getModelBias(scan, score)
⋮----
function buildNotes(scan, score, confidenceBand)
⋮----
function normalizeTimeframe(value)
⋮----
async function safeJson(request)
⋮----
function safeNumber(value, fallback = 0)
⋮----
function clamp(value, min = 1, max = 99)
⋮----
function json(data, status = 200)
````

## File: functions/api/mt5-sync.js
````javascript
export async function onRequestGet(context)
⋮----
export async function onRequestPost(context)
⋮----
async function handleMt5Sync(context)
⋮----
async function ensureMt5Tables(db)
⋮----
async function addColumnIfMissing(db, table, column, type)
⋮----
// Column already exists.
⋮----
function normalizeAccount(raw =
⋮----
function normalizeDeal(raw =
⋮----
function normalizePosition(raw =
⋮----
async function upsertAccount(db, account)
⋮----
async function upsertDeal(db, deal)
⋮----
async function upsertLearningTradeFromDeal(db, deal, account)
⋮----
async function clearPositionsForAccount(db, accountId)
⋮----
async function upsertPosition(db, position)
⋮----
async function getMt5Summary(db, accountId = "")
⋮----
function normalizeSymbol(value)
⋮----
function normalizeSide(value)
⋮----
function normalizeEntryType(value)
⋮----
function normalizeIsoDate(value)
⋮----
function inferSetupTypeFromComment(comment = "")
⋮----
function inferSessionFromIso(value)
⋮----
function inferHourFromIso(value)
⋮----
function percent(a, b)
⋮----
function round(value, digits = 2)
⋮----
function isAuthorized(request, secret)
⋮----
async function safeJson(request)
⋮----
function json(data, status = 200)
````

## File: functions/api/news-events.js
````javascript
export async function onRequestGet(context)
⋮----
export async function onRequestPost(context)
⋮----
async function handleNewsEvents(context)
⋮----
function isAuthorized(request, secret)
⋮----
async function safeJson(request)
⋮----
function json(data, status = 200)
````

## File: functions/api/paper-health.js
````javascript
export async function onRequestGet(context)
⋮----
export async function onRequestPost(context)
⋮----
async function handlePaperHealth(context)
⋮----
async function checkPair(db, pair, timeframe, nowSeconds, maxAgeSeconds)
⋮----
function getMaxAgeSeconds(timeframe, market)
⋮----
function getMarketStatus(date = new Date())
⋮----
function getParisParts(date)
⋮----
function buildStatusText(data)
⋮----
function normalizeTimeframe(value)
⋮----
function readBool(url, key, fallback = false)
⋮----
function isAuthorized(request, secret)
⋮----
function json(data, status = 200)
````

## File: functions/api/paper-run.js
````javascript
export async function onRequestGet(context)
⋮----
export async function onRequestPost(context)
⋮----
async function handlePaperRun(context)
⋮----
async function ensurePaperTables(db)
⋮----
async function ensurePaperColumns(db)
⋮----
async function addColumnIfMissing(db, table, column, type)
⋮----
// Column already exists.
⋮----
async function scanAllPairs(db, timeframe, pairs, config)
⋮----
async function getCandles(db, pair, timeframe)
⋮----
async function getArchiveStats(db, pair, timeframe)
⋮----
function normalizeDirectionStats(row)
⋮----
function buildEmptyScan(pair, timeframe, candles, reason)
⋮----
function buildScan(pair, timeframe, candles, archive, freshness, config)
⋮----
function applyFinalGate(scan, config)
⋮----
function blockScan(scan, reason)
⋮----
function buildBlockReason(data)
⋮----
function getDirection(data)
⋮----
function computeTrendScore(data)
⋮----
function computeTimingScore(data)
⋮----
function computeRiskScore(pair, volatility, atr14, current, timeframe)
⋮----
function computeExecutionScore(candles, direction, atr14)
⋮----
function computeSmartMoneyScore(candles, direction)
⋮----
function computeArchiveScore(archive, direction)
⋮----
function getDirectionArchive(archive, direction)
⋮----
function computeEntryQualityScore(data)
⋮----
function computeExitPressureScore(scan, trade = null, livePnlR = 0)
⋮----
function classifySetup(input)
⋮----
function emptySetup()
⋮----
function computeWickRiskScore(direction, upperWickRatio, lowerWickRatio, bodyRatio)
⋮----
function isLateImpulse(pair, timeframe, distanceEma20Atr, impulseTooLarge)
⋮----
function getMaxDistanceEma20(pair, timeframe)
⋮----
function getImpulseMaxMultiplier(pair, timeframe)
⋮----
function getVolatilityRegime(pair, volatility, atrPercent)
⋮----
function labelSetup(type)
⋮----
function computePaperCandidateScore(data)
⋮----
function computeRiskPercent(scan, config)
⋮----
function getMaxBarsHold(scan)
⋮----
function computeRiskDistance(pair, timeframe, current, atr14, setupType)
⋮----
function getOriginalRiskDistance(trade)
⋮----
function computeLivePnlR(trade, price)
⋮----
function computePnlR(trade, exitPrice)
⋮----
function improveStop(direction, currentStop, candidateStop)
⋮----
function buildRiskGroupsFromTrades(trades)
⋮----
function wouldOverloadRiskGroup(pair, currentGroups)
⋮----
function getPairRiskGroups(pair)
⋮----
function getFreshness(candles, timeframe)
⋮----
function getWinrateTargetRr(pair, timeframe, setupType = "")
⋮----
function scoreWinRate(winRate)
⋮----
function scoreExpectancy(value)
⋮----
function computeSessionScore(pair = "", timeframe = DEFAULT_TIMEFRAME, hour = inferHour(new Date()))
⋮----
function isTradableSession(pair, timeframe, hour)
⋮----
function weakness(score, level)
⋮----
function ema(values, period)
⋮----
function rsi(values, period = 14)
⋮----
function atr(highs, lows, closes, period = 14)
⋮----
function computeMomentum(values, lookback = 12)
⋮----
function computeVolatility(values, period = 40)
⋮----
function average(values)
⋮----
function inferSession(date = new Date())
⋮----
function inferHour(date = new Date())
⋮----
function buildConfig(env, url, body)
⋮----
function resolvePairs(env, url, body)
⋮----
function buildPaperAccountConfig(env =
⋮----
function publicConfig(config)
⋮----
function publicScan(scan)
⋮----
function normalizePair(value)
⋮----
function normalizeTimeframe(value)
⋮----
function extractSetupTypeFromTag(tag)
⋮----
function roundByPair(value, pair)
⋮----
function round(value, digits = 2)
⋮----
function clamp(value, min = 1, max = 99)
⋮----
function readNumber(url, body, env, queryKey, envKey, fallback)
⋮----
function readBool(url, body, key, fallback = false)
⋮----
function isAuthorized(request, secret)
⋮----
async function safeJson(request)
⋮----
function json(data, status = 200)
````

## File: functions/api/paper-trades.js
````javascript
export async function onRequestGet(context)
⋮----
export async function onRequestPost(context)
⋮----
async function getOpenTrades(db, timeframe, pair)
⋮----
async function getRecentClosedTrades(db, timeframe, pair, limit)
⋮----
async function getPairStats(db, timeframe)
⋮----
async function getSummary(db, timeframe)
⋮----
async function getRuns(db, timeframe)
⋮----
async function insertClosedTrade(db, trade)
⋮----
function normalizeOpenRow(row)
⋮----
function normalizeClosedRow(row)
⋮----
function normalizeClosedTrade(input)
⋮----
function computeLivePnlR(trade)
⋮----
function normalizePair(value)
⋮----
function normalizeTimeframe(value)
⋮----
function normalizeLimit(value, fallback = 50)
⋮----
function inferSession(date = new Date())
⋮----
function inferHour(date = new Date())
⋮----
function roundByPair(value, pair)
⋮----
function round(value, digits = 2)
⋮----
async function safeJson(request)
⋮----
function json(data, status = 200)
````

## File: functions/api/portfolio-risk.js
````javascript
export async function onRequestPost(context)
⋮----
export async function onRequestGet()
⋮----
function normalizePosition(position)
⋮----
function buildRiskGroups(positions)
⋮----
function getPairRiskGroups(pair)
⋮----
async function safeJson(request)
⋮----
function round(value, digits = 2)
⋮----
function json(data, status = 200)
````

## File: functions/api/quotes.js
````javascript

````

## File: functions/api/reset-paper-guard.js
````javascript
export async function onRequestGet(context)
⋮----
export async function onRequestPost(context)
⋮----
async function handleResetPaperGuard(context)
⋮----
async function ensureResetTables(db)
⋮----
async function getRecentPaperTrades(db, maxRows)
⋮----
function getConsecutiveLosses(trades)
⋮----
async function archiveTrade(db, resetId, trade)
⋮----
function publicTrade(trade)
⋮----
function readBool(url, body, key, fallback = false)
⋮----
async function safeJson(request)
⋮----
function isAuthorized(request, secret)
⋮----
function json(data, status = 200)
````

## File: functions/api/risk-engine.js
````javascript
export async function onRequestPost(context)
⋮----
function normalizePayload(data)
⋮----
async function safeJson(request)
⋮----
function clampNumber(value, min, max, fallback)
⋮----
function json(data, status = 200)
````

## File: functions/api/server-trading.js
````javascript
export async function onRequestGet(context)
⋮----
export async function onRequestPost(context)
⋮----
async function handleServerTrading(context)
⋮----
async function callEndpoint(origin, path, token, params =
⋮----
function buildSummary(results, options)
⋮----
function classifyCall(call)
⋮----
function buildSummaryMessage(data)
⋮----
async function insertServerTradingRun(db, data)
⋮----
// Optional log table.
⋮----
function parseTimeframes(value)
⋮----
function normalizeTimeframe(value)
⋮----
function readBool(url, body, key, fallback = false)
⋮----
async function safeJson(request)
⋮----
async function safeResponseJson(response)
⋮----
function isAuthorized(request, secret)
⋮----
function json(data, status = 200)
````

## File: functions/api/setup-alerts.js
````javascript
export async function onRequestGet(c)
export async function onRequestPost(c)
⋮----
async function handle(context)
⋮----
/* ================= CORE ================= */
⋮----
function n(c)
⋮----
function score(c)
⋮----
function isFtmoLocked(c)
⋮----
function isBadNews(c)
⋮----
/* ================= TELEGRAM ================= */
⋮----
async function send(env,text)
⋮----
function buildMsg(c)
⋮----
/* ================= UTILS ================= */
⋮----
function id()
⋮----
function json(d,s=200)
````

## File: functions/api/sync-market.js
````javascript
export async function onRequestGet(context)
⋮----
export async function onRequestPost(context)
⋮----
async function handleSyncMarket(context)
⋮----
async function syncPair(db, apiKey, pair, timeframe)
⋮----
function normalizeProviderCandle(row)
⋮----
function parseProviderTimestamp(value)
⋮----
function getPairsForGroup(group)
⋮----
function normalizeGroup(value)
⋮----
function normalizeTimeframe(value)
⋮----
function toProviderSymbol(pair)
⋮----
function isAuthorized(request, secret)
⋮----
async function safeJson(request)
⋮----
function sleep(ms)
⋮----
function json(data, status = 200)
````

## File: functions/api/timeframe-summary.js
````javascript
export async function onRequestGet(context)
⋮----
async function scanTimeframe(db, timeframe)
⋮----
async function getCandles(db, pair, timeframe)
⋮----
function buildScan(pair, timeframe, candles, freshness)
⋮----
function buildMtfAlignment(scansByTimeframe, timeframes)
⋮----
function computePairDirectionAlignment(pair, signal, pairScans)
⋮----
function getCandleFreshness(candles, timeframe)
⋮----
function ema(values, period)
⋮----
function rsi(values, period = 14)
⋮----
function atr(highs, lows, closes, period = 14)
⋮----
function computeMomentum(values, lookback = 12)
⋮----
function scoreSession(pair = "")
⋮----
function roundByPair(value, pair)
⋮----
function round(value, digits = 2)
⋮----
function clamp(value, min = 1, max = 99)
⋮----
function json(data, status = 200)
````

## File: functions/api/vectorbt-score.js
````javascript
export async function onRequestPost(context)
⋮----
export async function onRequestGet(context)
⋮----
function normalizeScan(input)
⋮----
function normalizeCandle(row)
⋮----
function scoreVectorbt(scan)
⋮----
function runLocalBacktest(scan, profile)
⋮----
function getBacktestSignal(data)
⋮----
function resolveTrade(
⋮----
function buildMetrics(trades, scan, profile)
⋮----
function computeMaxDrawdownR(trades)
⋮----
function scoreBacktestMetrics(metrics, scan, profile)
⋮----
function scoreWithoutCandles(scan, profile)
⋮----
function getPairProfile(pair)
⋮----
function getDefaultRr(pair)
⋮----
function getMaxBarsHold(timeframe, pair)
⋮----
function getSampleQuality(count, type)
⋮----
function getConfidenceBand(score, metrics)
⋮----
function getFallbackConfidenceBand(score)
⋮----
function getModelBias(scan, score)
⋮----
function buildNotes(scan, score, metrics, hasBacktest)
⋮----
function ema(values, period)
⋮----
function rsi(values, period = 14)
⋮----
function atr(highs, lows, closes, period = 14)
⋮----
function computeMomentum(values, lookback = 12)
⋮----
function normalizeTimeframe(value)
⋮----
function roundByPair(value, pair)
⋮----
async function safeJson(request)
⋮----
function safeNumber(value, fallback = 0)
⋮----
function round(value, digits = 2)
⋮----
function clamp(value, min = 1, max = 99)
⋮----
function json(data, status = 200)
````

## File: functions/_middleware.js
````javascript
export async function onRequest(context)
⋮----
function json(data, status = 200)
````

## File: scripts/import-dukascopy-csv-to-sql.mjs
````javascript
function main()
⋮----
function parseFileName(file)
⋮----
function parseCsv(raw, pair, timeframe)
⋮----
function looksLikeHeader(line)
⋮----
function splitDateTime(value)
⋮----
function toUnix(datePart, timePart)
⋮----
function normalizeDate(value)
⋮----
function normalizeTime(value)
⋮----
function toNum(value)
⋮----
function dedupeRows(rows)
⋮----
function esc(value)
⋮----
function buildSql(rows)
````

## File: _routes.json
````json
{
  "version": 1,
  "include": [
    "/api/*"
  ],
  "exclude": [
    "/app.js",
    "/api.js",
    "/config.js",
    "/state.js",
    "/render.js",
    "/scan.js",
    "/trades.js",
    "/utils.js",
    "/chart.js",
    "/indicators.js",
    "/mock.js",
    "/paper-engine.js",
    "/advanced-engine.js",
    "/styles.css",
    "/index.html",
    "/import.html"
  ]
}
````

## File: .repo-standards.yml
````yaml
source: dbrckk/repo-standards
ref: main
version: 20
adopted: true
workflow_mode: unified-single-commit
repo_brain: dbrckk/repo-brain@main
repo_brain_fallback: portable-full-rebuild
hotset_fallback: recent-project-state
graph_routing: compact-sharded-reverse-deps
graph_resolver: java-kotlin-tail-v2
graph_enrichment: unique-type-symbol-references-v1
context_budget: confidence-dynamic-3-6-12
routing_learning: deterministic-term-feedback-v1
auto_routing_learning: source-diff-success-v1
validation_memory: passed-failed-test-history-v1
regression_gate: repo-brain-core-tests-v1
benchmark: routing-benchmark-v1
stability_profile: stable-v1
benchmark_guard: avg-files-le-6-cache-required-v1
ai_context:
  index: .ai/index.md
  project_state: .ai/project-state.md
  change_impact: .ai/change-impact.md
  architecture: .ai/architecture.json
  dependency_map: .ai/dependency-map.json
  commands: .ai/commands.json
  ci_status: .ai/ci-status.md
  security_signals: .ai/security-signals.json
  repo_health: .ai/repo-health.md
  brain_summary: .ai/brain/summary.md
  brain_incremental_state: .ai/brain/incremental-state.json
  brain_impact: .ai/brain/impact.json
  brain_selected_tests: .ai/brain/selected-tests.json
  brain_references: .ai/brain/references.json
  brain_symbol_dependencies: .ai/brain/symbol-dependencies.json
  brain_capabilities: .ai/brain/capabilities.json
  brain_ast_routing: .ai/brain/ast-routing.json
  brain_ast_symbols: .ai/brain/ast-symbols/
  brain_file_outlines: .ai/brain/file-outlines/
  brain_lookup: .ai/brain/lookup.json
  brain_symbols: .ai/brain/symbols.json
  brain_graph: .ai/brain/code-graph.json
  brain_graph_index: .ai/brain/graph-index.json
  brain_graph_enrichment: .ai/brain/graph-enrichment.json
  brain_graph_manifest: .ai/brain/graph-manifest.json
  brain_graph_shards: .ai/brain/graph-shards/
  brain_reverse_deps: .ai/brain/reverse-deps.json
  brain_architecture_mermaid: .ai/brain/architecture.mmd
  brain_semantic_plan: .ai/brain/semantic-plan.json
  brain_semantic_index: .ai/brain/semantic-index.json
  brain_search_manifest: .ai/brain/search-manifest.json
  brain_search_shards: .ai/brain/search-shards/
  brain_query_cache: .ai/brain/query-cache.json
  brain_routing_learning: .ai/brain/routing-learning.json
  brain_auto_learning: .ai/brain/auto-learning.json
  brain_validation_memory: .ai/brain/validation-memory.json
  brain_benchmark: .ai/brain/benchmark.json
  brain_benchmark_health: .ai/brain/benchmark-health.json
  brain_hotset: .ai/brain/hotset.json
  brain_context_manifest: .ai/brain/context-manifest.json
  brain_context_packets: .ai/brain/context/
  brain_hash_cache: .ai/brain/hash-cache.json
  session_state: .ai/session-state.json
  repo_map: .ai/repo-map.md
  segmented_maps: .ai/maps/
workflow:
  file: .github/workflows/ai-repo-map.yml
  reusable_unified: .github/workflows/reusable-unified.yml
  semantic_refresh: .github/workflows/semantic-refresh.yml
````

## File: advanced-engine.js
````javascript
function clamp(value, min = 1, max = 99)
⋮----
function num(value, fallback = 0)
⋮----
function pctScore(winRate, neutral = 50)
⋮----
function expectancyScore(expectancy)
⋮----
function archiveConfidenceFactor(confidence)
⋮----
function scoreArchiveEdge(scan)
⋮----
function scoreSession(scan)
⋮----
function scoreSmartMoney(scan)
⋮----
function scoreExecution(scan)
⋮----
function scoreEntryPrecision(scan)
⋮----
function scoreMomentumQuality(scan)
⋮----
function scoreSpread(scan)
⋮----
function scoreGoldStructure(scan, archiveEdge, sessionScore)
⋮----
function scoreGoldDanger(scan, archiveEdge, sessionScore)
⋮----
function scoreMlAdjusted(scan, archiveEdge, sessionScore)
⋮----
export function computeUltraScore(scan)
⋮----
export function getTradeFilterDecision(scan)
````

## File: AGENTS.md
````markdown
# Repository agent instructions

This repository adopts shared standards from `dbrckk/repo-standards` at the release recorded in `.repo-standards.yml`.

Before substantial work:
1. Read the central `AGENTS.md` and relevant standards at the configured ref.
2. Read `.ai/session-state.json` when present.
3. Read `.ai/project-state.md`.
4. Read `.ai/brain/hotset.json`.
5. Read `.ai/brain/context-manifest.json` and only the relevant `.ai/brain/context/<area>.json` packet.
6. Read `.ai/brain/graph-index.json` and the relevant `.ai/brain/graph-shards/<area>.json` when dependency routing matters.
7. Use `.ai/brain/reverse-deps.json` for upstream/downstream file impact.
8. Read `.ai/brain/impact.json` and `.ai/brain/selected-tests.json`.
9. Read `.ai/brain/references.json` and `.ai/brain/symbol-dependencies.json` only when symbol routing requires them.
10. Read `.ai/change-impact.md` and `.ai/architecture.json` when broader structure is needed.
11. Read `.ai/brain/summary.md`, `.ai/brain/incremental-state.json`, and `.ai/brain/capabilities.json` when index freshness/capabilities matter.
12. If ast-grep enrichment is available, route named symbols through `.ai/brain/ast-routing.json` and one `.ai/brain/ast-symbols/<initial>.json` shard.
13. Fall back to `.ai/brain/lookup.json` when AST routing is unavailable or insufficient.
14. Use `.ai/brain/code-graph.json` and `.ai/brain/imports.json` for cross-module context.
15. Read `.ai/dependency-map.json` when dependency context matters.
16. Read `.ai/commands.json`, `.ai/ci-status.md`, and security signals when relevant.
17. Read `.ai/repo-health.md`.
18. Use `.ai/index.md` and segmented maps only if bounded context is insufficient.
19. Read `.ai/repo-map.md` only as a final broad-context fallback.
20. Fetch only task-relevant source files or line ranges.

Repository-specific rules:
- Preserve existing architecture and public interfaces unless the task requires a change.
- Prefer the smallest coherent change.
- Prefer targeted tests from `.ai/brain/selected-tests.json`; expand validation when impact is ambiguous or targeted tests fail.
- Treat hotset/context packets and graph shards as routing hints, not authoritative source.
- Verify reference/dependency/impact/AST hits against authoritative source before editing.
- Treat security signals and static graph edges as heuristics, not proof.
- Never reproduce suspected secret values.
- Update manual project-state sections when status, blockers, or next priority materially changes.
- Maintain `.ai/session-state.json` for substantial multi-turn work so a later "Continue" can resume without reconstructing the repository.
````

## File: api.js
````javascript
export async function fetchMlScore(scan)
⋮----
export async function fetchVectorbtScore(scan)
⋮----
export async function refreshAiDecision(force = false, callback = null)
⋮----
export async function fetchExitSuggestion(scan, ai, box = null)
⋮----
export async function fetchCorrelationMatrix()
⋮----
export async function fetchArchiveStatsBatch()
⋮----
export async function fetchServerPaperSnapshot()
⋮----
export async function fetchPaperHealth()
⋮----
export async function fetchTimeframeSummary()
⋮----
export async function saveClosedPaperTrade(trade)
⋮----
function enrichScanWithMtf(scan)
⋮----
function getMtfForPair(pair)
⋮----
function buildScanCacheKey(scan, prefix)
⋮----
async function getJson(url)
⋮----
async function postJson(path, payload)
⋮----
function escapeHtml(value)
````

## File: app.js
````javascript
function startApp()
⋮----
function bootstrapApp()
⋮----
function setupChartSafe()
⋮----
function cacheEls()
⋮----
function bindEvents()
⋮----
export async function refreshAll(force = false)
⋮----
async function refreshMetaData()
⋮----
async function refreshPostScanData(force)
⋮----
async function refreshPaperData()
⋮----
async function scanPairWithTimeout(pairEntry)
⋮----
function enrichScan(scan)
⋮----
function sortScans(scans)
⋮----
function renderDashboardAfterScan()
⋮----
function renderAllSafe()
⋮----
function renderLoadingState()
⋮----
function applyBrowserPaperMtfGuard(scans)
⋮----
function getMtfForPair(pair)
⋮----
function startPaperLoop()
⋮----
function renderTimeframeLabel()
⋮----
function clearScanCaches()
⋮----
function buildFallbackScan(pair, reason)
⋮----
function getPairSymbol(pairEntry)
⋮----
function withTimeout(promise, timeoutMs, fallbackValue)
⋮----
function showFatalError(label, error)
⋮----
function showPairListError(label, error)
⋮----
function setTextSafe(id, value)
⋮----
function sleep(ms)
⋮----
function escapeHtml(value)
````

## File: archive-engine.js
````javascript
export function getSessionLabelFromDate(date = new Date())
⋮----
export function normalizeArchivedTrade(raw)
⋮----
export function buildArchiveStats({
  pair,
  direction,
  archiveTrades = [],
  now = new Date()
})
⋮----
export function pushClosedTradeToArchive(appState, trade)
⋮----
export function computeArchiveConfidence({
  pairTrades = [],
  directionTrades = [],
  hourTrades = [],
  sessionTrades = []
})
⋮----
export function computeWinRate(trades)
⋮----
export function computeExpectancy(trades)
⋮----
function inferHour(dateLike)
````

## File: chart.js
````javascript
export function setupChart()
⋮----
export function updateChart(candles = [])
⋮----
function normalizeCandles(candles)
⋮----
function normalizeTime(value)
⋮----
function cleanupChart(clearContainer = true)
````

## File: config.js
````javascript

````

## File: d1-schema.sql
````sql
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
````

## File: indicators.js
````javascript
export function emaSeries(values = [], period = 20)
⋮----
export function smaSeries(values = [], period = 20)
⋮----
export function rsi(values = [], period = 14)
⋮----
export function atr(highs = [], lows = [], closes = [], period = 14)
⋮----
export function computeMomentum(values = [], lookback = 12)
⋮----
export function macd(values = [], fast = 12, slow = 26, signal = 9)
⋮----
export function bollingerBands(values = [], period = 20, multiplier = 2)
⋮----
export function stochastic(highs = [], lows = [], closes = [], period = 14)
````

## File: integration-patch.js
````javascript
// integration-patch.js
// PATCH À AJOUTER dans scan.js et app.js pour activer le moteur avancé
⋮----
/* ============================= */
/* PATCH scan.js */
/* ============================= */
⋮----
// 🔥 AJOUTER À LA FIN DE scanPair(scan)
⋮----
export function enhanceScanWithAdvancedEngine(scan)
⋮----
// override signal si bloqué
⋮----
/* ============================= */
/* PATCH app.js */
/* ============================= */
⋮----
// 🔥 remplace dans refreshAll :
⋮----
// AVANT
// scan.hedgeScore = computeHedgeScore(scan);
// scan.elite = isEliteTrade(scan);
// scan.confluence = computeConfluenceScore(scan);
⋮----
// APRÈS
⋮----
/*
import { enhanceScanWithAdvancedEngine } from "./integration-patch.js";

scan = enhanceScanWithAdvancedEngine(scan);

scan.hedgeScore = computeHedgeScore(scan);
scan.elite = isEliteTrade(scan);
scan.confluence = computeConfluenceScore(scan);
*/
⋮----
/* ============================= */
/* PATCH render.js */
/* ============================= */
⋮----
// 🔥 AJOUT UI dans renderSelectedPair()
⋮----
/*
metricCard("ULTRA", scan.ultraScore || 0, scan.ultraGrade || "-"),
*/
⋮----
// 🔥 AJOUT dans tradeSuggestionBox
⋮----
/*
Ultra Score: ${scan.ultraScore}<br>
Grade: ${scan.ultraGrade}<br>
Tag: ${scan.tag}<br>
*/
⋮----
/* ============================= */
/* RESULTAT FINAL */
/* ============================= */
⋮----
/*
Tu viens de passer de :

→ app basique scoring

à

→ moteur quasi hedge fund

avec :

✔ multi scoring
✔ filtrage intelligent
✔ session awareness
✔ risk gating
✔ ranking institutionnel

*/
⋮----
/* ============================= */
/* PROCHAIN UPGRADE */
/* ============================= */
⋮----
/*

Si tu veux aller encore plus loin :

1. Websocket prix réel
2. Backtest réel serveur (Python vectorbt)
3. Auto execution MT5 / Binance
4. Dashboard performance
5. IA auto-learning

*/
````

## File: mock.js
````javascript
export function generateFakeCandles(pair = "EURUSD", count = 220)
⋮----
export function generateFakeArchiveTrades(pair = "EURUSD", count = 80)
⋮----
function getBasePrice(pair)
⋮----
function getStep(pair)
⋮----
function roundByPair(value, pair)
⋮----
function pseudoNoise(pair, index)
⋮----
function hashCode(str)
⋮----
function getFakeSession(index)
````

## File: package.json
````json
{
  "name": "ftmo-edge-ai",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "FTMO Edge AI scanner with Cloudflare Pages, D1 archive, paper learning engine, local ML scoring, and automated market sync",
  "scripts": {
    "dev": "wrangler pages dev .",
    "deploy": "wrangler pages deploy .",
    "check": "node -e \"console.log('ok')\"",
    "vectorbt:dev": "python -m uvicorn backtesting.vectorbt_service:app --host 0.0.0.0 --port 8000",
    "vectorbt:dev:reload": "python -m uvicorn backtesting.vectorbt_service:app --host 0.0.0.0 --port 8000 --reload"
  },
  "dependencies": {
    "@tensorflow/tfjs": "^4.22.0",
    "technicalindicators": "^3.1.0"
  },
  "devDependencies": {
    "wrangler": "^4.0.0"
  }
}
````

## File: paper-engine.js
````javascript
export async function runPaperEngine(scans = [])
⋮----
async function updateBrowserPaperTrades(scans)
⋮----
function openBrowserPaperTrades(scans)
⋮----
function enrichCandidate(scan)
⋮----
function createBrowserPaperTrade(scan, exploration = false)
⋮----
function manageOpenTrade(trade, price, scan)
⋮----
function computeEntryQualityScore(scan)
⋮----
function computeCandleTriggerScore(candles, direction)
⋮----
function computeLateEntryPenalty(candles, direction, pair)
⋮----
function computeExitPressureScore(scan, trade = null, livePnlR = 0)
⋮----
function isLateEntry(scan)
⋮----
function getMaxBarsHold(scan, exploration)
⋮----
function computePnlRWithPartial(trade, exitPrice)
⋮----
function buildClosedTrade(trade, exitPrice, closeReason, scan, forcedPnlR = null)
⋮----
function scorePaperCandidate(scan)
⋮----
function computeBrowserRiskPercent(scan)
⋮----
function computeLivePnlR(trade, price)
⋮----
function getOriginalRiskDistance(trade)
⋮----
function improveStop(direction, currentStop, candidateStop)
⋮----
function buildRiskGroupsFromTrades(trades)
⋮----
function wouldOverloadRiskGroup(pair, currentGroups)
⋮----
function getPairRiskGroups(pair)
⋮----
export function computePaperAnalytics()
⋮----
function weakness(score, level)
⋮----
function ema(values, period)
⋮----
function atr(highs, lows, closes, period = 14)
⋮----
function average(values)
⋮----
function inferSession(date = new Date())
⋮----
function inferHour(date = new Date())
⋮----
function roundByPair(value, pair)
⋮----
function round(value, digits = 2)
⋮----
function clamp(value, min = 1, max = 99)
````

## File: README.md
````markdown
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
````

## File: render.js
````javascript
export function setActiveTab(tabName)
⋮----
export function renderTabs()
⋮----
export function renderOverview()
⋮----
export function renderPairList(refreshAiDecision)
⋮----
export function renderTopPriorityTrades()
⋮----
export function renderTopBlockedTrades()
⋮----
export function renderCorrelationMatrix()
⋮----
export function renderSelectedPair()
⋮----
export function renderTrades()
⋮----
export function renderWatchlist()
⋮----
export function renderFtmoRisk()
⋮----
export function renderPaperLab()
⋮----
export function renderPaperHealth()
⋮----
export function renderTimeframeSummary()
⋮----
function renderOpenPaperTrade(trade, sourceLabel)
⋮----
function renderClosedPaperTrade(trade)
⋮----
function getBestPaperCandidate()
⋮----
function weightedPaperScore(scan)
⋮----
function computeLiveR(trade)
⋮----
function parseEqFromModelTag(tag)
⋮----
function getMtfForPair(pair)
⋮----
function pickBestMtfTimeframe(mtfItem)
⋮----
function formatAlignedTimeframes(timeframes)
⋮----
function formatDateShort(value)
⋮----
function esc(value)
````

## File: scan.js
````javascript
export async function scanPair(pairEntry)
⋮----
async function fetchMarketCandles(pair, timeframe)
⋮----
function buildLocalScan(pair, timeframe, candles)
⋮----
function applyArchiveLearning(scan, archive)
⋮----
function computeUltraScore(scan)
⋮----
function computeEntryQualityScore(scan)
⋮----
function computeExitPressureScore(scan)
⋮----
function computePaperScore(scan)
⋮----
function buildTradeDecision(scan)
⋮----
function getTradeProfile(pair)
⋮----
function computeDirection(data)
⋮----
function computeTrendScore(data)
⋮----
function computeTimingScore(data)
⋮----
function computeRiskScore(data)
⋮----
function computeExecutionScore(candles, direction, atr14)
⋮----
function computeSmartMoneyScore(candles, direction)
⋮----
function computeContextScore(data)
⋮----
function computeSessionScore(pair = "")
⋮----
function isLateEntry(scan)
⋮----
function computeRiskDistance(pair, current, atr14)
⋮----
function buildBaseReasons(data)
⋮----
function getArchiveStats(pair)
⋮----
function normalizeArchiveSide(side)
⋮----
function getDirectionArchive(archive, direction)
⋮----
export function computeConfluenceScore(scan)
⋮----
export function computeHedgeScore(scan)
⋮----
export function isEliteTrade(scan)
⋮----
function buildFallbackScan(pair, timeframe, candles = [], reason = "No data")
⋮----
function normalizeCandle(row)
⋮----
function fetchWithTimeout(url, timeoutMs)
⋮----
function getPairSymbol(pairEntry)
⋮----
function getUltraGrade(score)
⋮----
function getDefaultRr(pair)
⋮----
function scoreWinRate(winRate)
⋮----
function scoreExpectancy(expectancy)
⋮----
function weakness(score, level)
⋮----
function ema(values, period)
⋮----
function rsi(values, period = 14)
⋮----
function atr(highs, lows, closes, period = 14)
⋮----
function computeMomentum(values, lookback = 12)
⋮----
function computeVolatility(values, period = 30)
⋮----
function average(values)
⋮----
function inferHour(date = new Date())
⋮----
function roundByPair(value, pair)
⋮----
function round(value, digits = 2)
⋮----
function clamp(value, min = 1, max = 99)
````

## File: setup-classifier.js
````javascript
export function classifySetup(input =
⋮----
function computeWickRiskScore(data)
⋮----
function isLateImpulse(pair, distanceEma20Atr, impulseTooLarge)
⋮----
function getVolatilityRegime(pair, volatility, atrPercent)
⋮----
function labelSetup(type)
⋮----
function ema(values, period)
⋮----
function atr(highs, lows, closes, period = 14)
⋮----
function computeMomentum(values, lookback = 12)
⋮----
function computeVolatility(values, period = 30)
⋮----
function average(values)
⋮----
function clamp(value, min = 1, max = 99)
````

## File: state.js
````javascript
function createInitialState()
⋮----
function loadSavedState()
⋮----
export function persistState()
⋮----
export function resetState()
⋮----
export function clearRuntimeCaches()
⋮----
function migrateState(state)
⋮----
function sanitizeState(state)
⋮----
function normalizePair(value)
⋮----
function isValidPair(pair)
⋮----
function normalizeTimeframe(value)
⋮----
function clampNumber(value, min, max, fallback)
⋮----
function safeNumber(value, fallback = 0)
⋮----
function isPlainObject(value)
⋮----
function deepMerge(target, source)
⋮----
function structuredCloneSafe(value)
````

## File: trades.js
````javascript
export function onAddTrade(event, renderTrades, renderFtmoRisk)
⋮----
export function clearTrades(renderTrades)
⋮----
export function toggleCurrentWatchlist(renderWatchlist)
⋮----
export function exportTradesJson()
⋮----
export function computeDynamicRiskPercent(scan)
⋮----
export function computePositionSizing(scan, capital = 10000, forcedRiskPercent = null)
⋮----
function buildFallbackStop(pair, direction, entry)
⋮----
function buildFallbackTarget(pair, direction, entry, stopLoss)
⋮----
function computeRr(entry, stopLoss, takeProfit, direction)
⋮----
function signalToDirection(signal)
⋮----
function roundByPair(value, pair)
⋮----
function formatBtcAmount(value)
````

## File: utils.js
````javascript
export function clamp(value, min = 0, max = 100)
⋮----
export function round(value, digits = 2)
⋮----
export function formatPrice(value, pair = "")
⋮----
export function setText(id, value)
⋮----
export function setValue(id, value)
⋮----
export function metricCard(label, value, hint = "")
⋮----
export function sanitizeDecision(value)
⋮----
export function escapeHtml(value)
⋮----
export function downloadJson(filename, data)
⋮----
export function safeNumber(value, fallback = 0)
⋮----
export function average(values)
⋮----
export function nowIso()
````
