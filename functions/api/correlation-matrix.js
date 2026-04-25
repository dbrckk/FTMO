const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD", "BTCUSD"
];

const DEFAULT_LIMIT = 160;
const MAX_LIMIT = 400;

export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const rows = Array.isArray(body.rows) ? body.rows : [];

    const normalizedRows = rows
      .map(normalizeInputRow)
      .filter(Boolean);

    if (!normalizedRows.length) {
      return json({
        ok: true,
        source: "correlation-matrix",
        version: "correlation-btc-v2",
        pairs: [],
        matrix: [],
        alerts: [],
        clusters: [],
        message: "No usable rows provided."
      });
    }

    const pairs = normalizedRows.map((row) => row.pair);
    const matrix = buildCorrelationMatrix(normalizedRows);
    const alerts = buildCorrelationAlerts(pairs, matrix);
    const clusters = buildRiskClusters(normalizedRows, matrix);

    return json({
      ok: true,
      source: "correlation-matrix",
      version: "correlation-btc-v2",
      pairs,
      matrix,
      alerts,
      clusters,
      cryptoPairs: pairs.filter((pair) => pair === "BTCUSD"),
      metalPairs: pairs.filter((pair) => pair === "XAUUSD")
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "correlation-matrix-error"),
      pairs: [],
      matrix: [],
      alerts: [],
      clusters: []
    }, 500);
  }
}

export async function onRequestGet(context) {
  try {
    const db = context.env?.DB;

    if (!db) {
      return json({
        ok: false,
        error: "Missing DB binding"
      }, 500);
    }

    const url = new URL(context.request.url);
    const timeframe = normalizeTimeframe(url.searchParams.get("timeframe")) || "M15";
    const limit = normalizeLimit(url.searchParams.get("limit"));

    const rows = [];

    for (const pair of PAIRS) {
      const candles = await getCandles(db, pair, timeframe, limit);

      if (candles.length >= 30) {
        rows.push({
          pair,
          closes: candles.map((candle) => candle.close)
        });
      }
    }

    const normalizedRows = rows
      .map(normalizeInputRow)
      .filter(Boolean);

    const pairs = normalizedRows.map((row) => row.pair);
    const matrix = buildCorrelationMatrix(normalizedRows);
    const alerts = buildCorrelationAlerts(pairs, matrix);
    const clusters = buildRiskClusters(normalizedRows, matrix);

    return json({
      ok: true,
      source: "correlation-matrix",
      version: "correlation-btc-v2",
      timeframe,
      limit,
      pairs,
      matrix,
      alerts,
      clusters,
      cryptoPairs: pairs.filter((pair) => pair === "BTCUSD"),
      metalPairs: pairs.filter((pair) => pair === "XAUUSD")
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "correlation-matrix-get-error"),
      pairs: [],
      matrix: [],
      alerts: [],
      clusters: []
    }, 500);
  }
}

async function getCandles(db, pair, timeframe, limit) {
  const res = await db
    .prepare(`
      SELECT close
      FROM market_candles
      WHERE pair = ?
        AND timeframe = ?
      ORDER BY ts DESC
      LIMIT ?
    `)
    .bind(pair, timeframe, limit)
    .all();

  const rows = Array.isArray(res.results) ? res.results : [];

  return rows
    .map((row) => ({
      close: Number(row.close || 0)
    }))
    .filter((row) => Number.isFinite(row.close) && row.close > 0)
    .reverse();
}

function normalizeInputRow(row) {
  const pair = normalizePair(row?.pair);
  const closes = Array.isArray(row?.closes) ? row.closes : [];

  if (!pair) return null;

  const cleanCloses = closes
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);

  if (cleanCloses.length < 20) return null;

  return {
    pair,
    closes: cleanCloses.slice(-MAX_LIMIT),
    returns: toReturns(cleanCloses.slice(-MAX_LIMIT))
  };
}

function buildCorrelationMatrix(rows) {
  return rows.map((rowA) => {
    return rows.map((rowB) => {
      if (rowA.pair === rowB.pair) return 1;

      const corr = pearson(rowA.returns, rowB.returns);

      return round(corr, 3);
    });
  });
}

function buildCorrelationAlerts(pairs, matrix) {
  const alerts = [];

  for (let i = 0; i < pairs.length; i += 1) {
    for (let j = i + 1; j < pairs.length; j += 1) {
      const pairA = pairs[i];
      const pairB = pairs[j];
      const corr = Number(matrix[i]?.[j] || 0);
      const absCorr = Math.abs(corr);

      if (absCorr < 0.75) continue;

      const riskType = getCorrelationRiskType(pairA, pairB, corr);

      alerts.push({
        pairA,
        pairB,
        correlation: round(corr, 3),
        absCorrelation: round(absCorr, 3),
        level: absCorr >= 0.9 ? "EXTREME" : absCorr >= 0.82 ? "HIGH" : "MEDIUM",
        riskType,
        message: `${pairA}/${pairB} correlation ${round(corr, 2)}`
      });
    }
  }

  return alerts.sort((a, b) => Number(b.absCorrelation || 0) - Number(a.absCorrelation || 0));
}

function buildRiskClusters(rows, matrix) {
  const pairs = rows.map((row) => row.pair);
  const clusters = [];

  const usdPairs = pairs.filter((pair) => pair.includes("USD"));
  const eurPairs = pairs.filter((pair) => pair.includes("EUR"));
  const gbpPairs = pairs.filter((pair) => pair.includes("GBP"));
  const jpyPairs = pairs.filter((pair) => pair.includes("JPY"));
  const audNzdPairs = pairs.filter((pair) => pair.includes("AUD") || pair.includes("NZD"));
  const goldPairs = pairs.filter((pair) => pair === "XAUUSD");
  const cryptoPairs = pairs.filter((pair) => pair === "BTCUSD");

  pushCluster(clusters, "USD", usdPairs, pairs, matrix);
  pushCluster(clusters, "EUR", eurPairs, pairs, matrix);
  pushCluster(clusters, "GBP", gbpPairs, pairs, matrix);
  pushCluster(clusters, "JPY", jpyPairs, pairs, matrix);
  pushCluster(clusters, "AUD_NZD", audNzdPairs, pairs, matrix);
  pushCluster(clusters, "GOLD_USD", goldPairs, pairs, matrix);
  pushCluster(clusters, "BTC_USD", cryptoPairs, pairs, matrix);

  return clusters.filter((cluster) => cluster.pairs.length > 0);
}

function pushCluster(clusters, name, clusterPairs, allPairs, matrix) {
  const uniquePairs = [...new Set(clusterPairs)];

  if (!uniquePairs.length) return;

  clusters.push({
    name,
    pairs: uniquePairs,
    count: uniquePairs.length,
    averageAbsCorrelation: computeClusterAverageAbsCorrelation(uniquePairs, allPairs, matrix),
    specialRisk:
      name === "BTC_USD"
        ? "Crypto isolated exposure"
        : name === "GOLD_USD"
          ? "Gold isolated exposure"
          : ""
  });
}

function computeClusterAverageAbsCorrelation(clusterPairs, allPairs, matrix) {
  if (clusterPairs.length <= 1) return 0;

  const values = [];

  for (let i = 0; i < clusterPairs.length; i += 1) {
    for (let j = i + 1; j < clusterPairs.length; j += 1) {
      const indexA = allPairs.indexOf(clusterPairs[i]);
      const indexB = allPairs.indexOf(clusterPairs[j]);

      if (indexA === -1 || indexB === -1) continue;

      values.push(Math.abs(Number(matrix[indexA]?.[indexB] || 0)));
    }
  }

  if (!values.length) return 0;

  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 3);
}

function getCorrelationRiskType(pairA, pairB, corr) {
  if (pairA === "BTCUSD" || pairB === "BTCUSD") {
    return "CRYPTO_CORRELATION";
  }

  if (pairA === "XAUUSD" || pairB === "XAUUSD") {
    return "GOLD_CORRELATION";
  }

  if (pairA.includes("USD") && pairB.includes("USD")) {
    return corr > 0 ? "USD_SAME_DIRECTION" : "USD_INVERSE_DIRECTION";
  }

  if (pairA.includes("JPY") && pairB.includes("JPY")) {
    return "JPY_CLUSTER";
  }

  if (pairA.includes("GBP") && pairB.includes("GBP")) {
    return "GBP_CLUSTER";
  }

  if (pairA.includes("EUR") && pairB.includes("EUR")) {
    return "EUR_CLUSTER";
  }

  return "GENERAL_CORRELATION";
}

function toReturns(values) {
  const out = [];

  for (let i = 1; i < values.length; i += 1) {
    const prev = Number(values[i - 1]);
    const current = Number(values[i]);

    if (!prev || !current) continue;

    out.push((current - prev) / prev);
  }

  return out;
}

function pearson(a, b) {
  const length = Math.min(a.length, b.length);

  if (length < 3) return 0;

  const x = a.slice(-length);
  const y = b.slice(-length);

  const avgX = average(x);
  const avgY = average(y);

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < length; i += 1) {
    const dx = x[i] - avgX;
    const dy = y[i] - avgY;

    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denominator = Math.sqrt(denomX * denomY);

  if (!denominator) return 0;

  return numerator / denominator;
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);

  if (!nums.length) return 0;

  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function normalizePair(value) {
  const pair = String(value || "")
    .toUpperCase()
    .replace("/", "")
    .trim();

  if (!pair) return "";

  return PAIRS.includes(pair) ? pair : "";
}

function normalizeTimeframe(value) {
  const timeframe = String(value || "")
    .toUpperCase()
    .trim();

  return ["M5", "M15", "H1", "H4"].includes(timeframe) ? timeframe : "";
}

function normalizeLimit(value) {
  const limit = Number(value || DEFAULT_LIMIT);

  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  if (limit < 30) return 30;
  if (limit > MAX_LIMIT) return MAX_LIMIT;

  return Math.round(limit);
}

async function safeJson(request) {
  try {
    const contentType = request.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("application/json")) {
      return {};
    }

    return await request.json();
  } catch {
    return {};
  }
}

function round(value, digits = 3) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Number(n.toFixed(digits));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
        }
