export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const rows = Array.isArray(body.rows) ? body.rows : [];

    if (!rows.length) {
      return json({
        ok: true,
        pairs: [],
        matrix: []
      });
    }

    const pairs = rows.map((r) => String(r.pair || "").toUpperCase());
    const seriesMap = Object.fromEntries(
      rows.map((r) => [
        String(r.pair || "").toUpperCase(),
        Array.isArray(r.closes) ? r.closes.map((x) => Number(x)).filter(Number.isFinite) : []
      ])
    );

    const matrix = pairs.map((a) => {
      return pairs.map((b) => {
        const corr = pearson(toReturns(seriesMap[a]), toReturns(seriesMap[b]));
        return Number.isFinite(corr) ? Number(corr.toFixed(4)) : 0;
      });
    });

    return json({
      ok: true,
      pairs,
      matrix
    });
  } catch {
    return json({
      ok: false,
      pairs: [],
      matrix: []
    }, 500);
  }
}

function toReturns(series) {
  const out = [];
  for (let i = 1; i < series.length; i += 1) {
    const prev = Number(series[i - 1] || 0);
    const curr = Number(series[i] || 0);
    if (prev > 0 && curr > 0) {
      out.push((curr - prev) / prev);
    }
  }
  return out;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;

  const x = a.slice(-n);
  const y = b.slice(-n);

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let num = 0;
  let denX = 0;
  let denY = 0;

  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  if (!den) return 0;
  return num / den;
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
