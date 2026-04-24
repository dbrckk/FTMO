export async function onRequestGet(context) {
  try {
    if (!context.env?.DB) {
      return json({
        ok: true,
        dbBound: false,
        totalPairs: 0,
        totalRows: 0,
        summary: []
      });
    }

    const summaryRes = await context.env.DB
      .prepare(`
        SELECT pair, timeframe, COUNT(*) AS rows
        FROM market_candles
        GROUP BY pair, timeframe
        ORDER BY pair, timeframe
      `)
      .all();

    const summary = Array.isArray(summaryRes.results) ? summaryRes.results : [];
    const totalPairs = new Set(summary.map((r) => r.pair)).size;
    const totalRows = summary.reduce((sum, row) => sum + Number(row.rows || 0), 0);

    return json({
      ok: true,
      dbBound: true,
      totalPairs,
      totalRows,
      summary
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "import-status-error")
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env?.DB;
    if (!db) {
      return json({ ok: false, error: "D1 binding DB missing" }, 500);
    }

    const form = await context.request.formData();

    const pair = cleanPair(form.get("pair"));
    const timeframe = normalizeTimeframe(form.get("timeframe"));
    const replaceExisting = String(form.get("replaceExisting") || "0") === "1";
    const file = form.get("file");

    if (!pair) {
      return json({ ok: false, error: "Missing pair" }, 400);
    }

    if (!timeframe) {
      return json({ ok: false, error: "Missing timeframe" }, 400);
    }

    if (!file || typeof file.text !== "function") {
      return json({ ok: false, error: "Missing file" }, 400);
    }

    const raw = await file.text();
    const parsedRows = parseCsv(raw, pair, timeframe);

    if (!parsedRows.length) {
      return json({ ok: false, error: "No valid CSV rows parsed" }, 400);
    }

    const dedupedRows = dedupeRows(parsedRows);

    if (replaceExisting) {
      await db
        .prepare(`DELETE FROM market_candles WHERE pair = ? AND timeframe = ?`)
        .bind(pair, timeframe)
        .run();
    }

    const inserted = await insertRows(db, dedupedRows);

    return json({
      ok: true,
      pair,
      timeframe,
      rowsParsed: parsedRows.length,
      rowsImported: inserted,
      rowsSkipped: Math.max(0, parsedRows.length - dedupedRows.length),
      replaceExisting,
      source: "dukascopy"
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "import-market-csv-error")
    }, 500);
  }
}

async function insertRows(db, rows) {
  const CHUNK = 200;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);

    const statements = chunk.map((row) =>
      db.prepare(`
        INSERT OR REPLACE INTO market_candles
        (pair, timeframe, ts, open, high, low, close, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        row.pair,
        row.timeframe,
        row.ts,
        row.open,
        row.high,
        row.low,
        row.close,
        row.source
      )
    );

    await db.batch(statements);
    inserted += chunk.length;
  }

  return inserted;
}

function parseCsv(raw, pair, timeframe) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const rows = [];

  for (const line of lines) {
    if (looksLikeHeader(line)) continue;

    const delimiter = line.includes(";") ? ";" : ",";
    const parts = line.split(delimiter).map((p) => p.trim());

    if (parts.length < 5) continue;

    let datePart = "";
    let timePart = "";
    let open = "";
    let high = "";
    let low = "";
    let close = "";

    if (parts.length >= 6) {
      datePart = parts[0];
      timePart = parts[1];
      open = parts[2];
      high = parts[3];
      low = parts[4];
      close = parts[5];
    } else {
      const split = splitDateTime(parts[0]);
      datePart = split.datePart;
      timePart = split.timePart;
      open = parts[1];
      high = parts[2];
      low = parts[3];
      close = parts[4];
    }

    const ts = toUnix(datePart, timePart);
    const o = toNum(open);
    const h = toNum(high);
    const l = toNum(low);
    const c = toNum(close);

    if (
      !Number.isFinite(ts) ||
      !Number.isFinite(o) ||
      !Number.isFinite(h) ||
      !Number.isFinite(l) ||
      !Number.isFinite(c)
    ) {
      continue;
    }

    rows.push({
      pair,
      timeframe,
      ts,
      open: o,
      high: h,
      low: l,
      close: c,
      source: "dukascopy"
    });
  }

  return rows;
}

function looksLikeHeader(line) {
  const lower = line.toLowerCase();
  return (
    lower.includes("date") ||
    lower.includes("time") ||
    lower.includes("open") ||
    lower.includes("high") ||
    lower.includes("low") ||
    lower.includes("close")
  );
}

function splitDateTime(value) {
  const clean = String(value).trim();
  if (clean.includes(" ")) {
    const [datePart, timePart] = clean.split(/\s+/, 2);
    return { datePart, timePart };
  }
  return { datePart: clean, timePart: "00:00:00" };
}

function toUnix(datePart, timePart) {
  const d = normalizeDate(datePart);
  const t = normalizeTime(timePart);
  const iso = `${d}T${t}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

function normalizeDate(value) {
  const v = String(value).trim().replace(/\./g, "-").replace(/\//g, "-");

  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  if (/^\d{2}-\d{2}-\d{4}$/.test(v)) {
    const [dd, mm, yyyy] = v.split("-");
    return `${yyyy}-${mm}-${dd}`;
  }

  if (/^\d{8}$/.test(v)) {
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }

  return v;
}

function normalizeTime(value) {
  const v = String(value || "00:00:00").trim();

  if (/^\d{2}:\d{2}$/.test(v)) return `${v}:00`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(v)) return v;
  if (/^\d{6}$/.test(v)) return `${v.slice(0, 2)}:${v.slice(2, 4)}:${v.slice(4, 6)}`;

  return "00:00:00";
}

function toNum(value) {
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function dedupeRows(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = `${row.pair}|${row.timeframe}|${row.ts}`;
    map.set(key, row);
  }

  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

function cleanPair(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function normalizeTimeframe(value) {
  const tf = String(value || "").toUpperCase().trim();
  return ["M5", "M15", "H1", "H4"].includes(tf) ? tf : "";
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
