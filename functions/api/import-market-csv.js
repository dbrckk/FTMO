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

    const payload = await parseIncomingRequest(context.request);

    const pair = cleanPair(payload.pair);
    const timeframe = normalizeTimeframe(payload.timeframe);
    const replaceExisting = String(payload.replaceExisting || "0") === "1";

    if (!pair) {
      return json({ ok: false, error: "Missing pair" }, 400);
    }

    if (!timeframe) {
      return json({ ok: false, error: "Missing timeframe" }, 400);
    }

    let raw = "";

    if (typeof payload.csvText === "string" && payload.csvText.trim()) {
      raw = payload.csvText.trim();
    } else if (payload.file && typeof payload.file.text === "function") {
      raw = await payload.file.text();
    }

    if (!raw) {
      return json({ ok: false, error: "Missing CSV content" }, 400);
    }

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

async function parseIncomingRequest(request) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    return {
      pair: form.get("pair"),
      timeframe: form.get("timeframe"),
      replaceExisting: form.get("replaceExisting"),
      csvText: form.get("csvText"),
      file: form.get("file")
    };
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    return {
      pair: form.get("pair"),
      timeframe: form.get("timeframe"),
      replaceExisting: form.get("replaceExisting"),
      csvText: form.get("csvText"),
      file: null
    };
  }

  if (contentType.includes("application/json")) {
    const body = await request.json();
    return {
      pair: body?.pair,
      timeframe: body?.timeframe,
      replaceExisting: body?.replaceExisting,
      csvText: body?.csvText,
      file: null
    };
  }

  const text = await request.text();
  return {
    pair: "",
    timeframe: "",
    replaceExisting: "0",
    csvText: text,
    file: null
  };
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

    const delimiter = detectDelimiter(line);
    const parts = line
      .split(delimiter)
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length < 5) continue;

    let datePart = "";
    let timePart = "";
    let open = "";
    let high = "";
    let low = "";
    let close = "";

    if (parts[0].includes(" ") && isNumeric(parts[1])) {
      const split = splitDateTime(parts[0]);
      datePart = split.datePart;
      timePart = split.timePart;
      open = parts[1];
      high = parts[2];
      low = parts[3];
      close = parts[4];
    } else if (parts.length >= 6 && looksLikeDate(parts[0]) && looksLikeTime(parts[1])) {
      datePart = parts[0];
      timePart = parts[1];
      open = parts[2];
      high = parts[3];
      low = parts[4];
      close = parts[5];
    } else if (parts.length === 5 && parts[0].includes(" ")) {
      const split = splitDateTime(parts[0]);
      datePart = split.datePart;
      timePart = split.timePart;
      open = parts[1];
      high = parts[2];
      low = parts[3];
      close = parts[4];
    } else {
      continue;
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

function detectDelimiter(line) {
  if (line.includes("\t")) return "\t";
  if (line.includes(";")) return ";";
  return ",";
}

function isNumeric(value) {
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n);
}

function looksLikeDate(value) {
  const v = String(value).trim();
  return (
    /^\d{4}[./-]\d{2}[./-]\d{2}$/.test(v) ||
    /^\d{2}[./-]\d{2}[./-]\d{4}$/.test(v) ||
    /^\d{8}$/.test(v)
  );
}

function looksLikeTime(value) {
  const v = String(value).trim();
  return /^\d{2}:\d{2}(:\d{2})?$/.test(v);
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
