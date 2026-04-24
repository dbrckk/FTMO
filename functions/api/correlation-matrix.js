export async function onRequestPost(context) {
  try {
    const body = await safeJson(context.request);
    const rows = Array.isArray(body.rows) ? body.rows : [];

    if (!rows.length) {
      return json({
        ok: true,
        pairs: [],
        matrix: [],
        alerts: []
      });
    }

    const normalized = rows
      .map((row) => ({
        pair: String(row.pair || "").toUpperCase(),
        closes: Array.isArray(row.closes)
          ? row.closes.map(Number).filter(Number.isFinite)
          : []
      }))
      .filter((row) => row.pair && row.closes.length >= 20)
      .slice(0, 25);

    const pairs = normalized.map((row) => row.pair);
    const matrix = [];

    for (let i = 0; i < normalized.length; i += 1) {
      const row = [];

      for (let j = 0; j < normalized.length; j += 1) {
        if (i === j) {
          row.push(1);
        } else {
          row.push(
            Number(
              correlation(
                normalized[i].closes,
                normalized[j].closes
              ).toFixed(3)
            )
          );
        }
      }

      matrix.push(row);
    }

    const alerts = [];

    for (let i = 0; i < pairs.length; i += 1) {
      for (let j = i + 1; j < pairs.length; j += 1) {
        const value = Number(matrix[i][j] || 0);

        if (Math.abs(value) >= 0.85) {
          alerts.push({
            pairA: pairs[i],
            pairB: pairs[j],
            correlation: value,
            level: "high"
          });
        } else if (Math.abs(value) >= 0.7) {
          alerts.push({
            pairA: pairs[i],
            pairB: pairs[j],
            correlation: value,
            level: "medium"
          });
        }
      }
    }

    return json({
      ok: true,
      pairs,
      matrix,
      alerts
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "correlation-error"),
      pairs: [],
      matrix: [],
      alerts: []
    }, 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    message: "POST rows to compute correlation matrix."
  });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function correlation(a, b) {
  const length = Math.min(a.length, b.length);
  if (length < 2) return 0;

  const x = a.slice(-length);
  const y = b.slice(-length);

  const meanX = average(x);
  const meanY = average(y);

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < length; i += 1) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;

    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denominator = Math.sqrt(denomX * denomY);

  if (!Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }

  return numerator / denominator;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
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
