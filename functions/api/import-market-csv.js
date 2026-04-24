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

    const parsed = parseCsv(raw, pair, timeframe);

    if (!parsed.rows.length) {
      return json({
        ok: false,
        error: "No valid CSV rows parsed",
        debug: parsed.debug
      }, 400);
    }

    const dedupedRows = dedupeRows(parsed.rows);

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
      rowsParsed: parsed.rows.length,
      rowsImported: inserted,
      rowsSkipped: Math.max(0, parsed.rows.length - dedupedRows.length),
      replaceExisting,
      source: "dukascopy",
      debug: {
        totalLines: parsed.debug.totalLines,
        sampleDelimiter: parsed.debug.sampleDelimiter
      }
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
  const cleanedRaw = String(raw || "").replace(/^\uFEFF/, "");
  const lines = cleanedRaw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const debug = {
    totalLines: lines.length,
    firstNonEmptyLines: lines.slice(0, 3),
    sampleDelimiter: lines[0] ? detectDelimiter(lines[0]) : ","
  };

  if (!lines.length) return { rows: [], debug };

  const rows = [];

  for (const line of lines) {
    if (looksLikeHeader(line)) continue;

    const delimiter = detectDelimiter(line);
    const parts = splitCsvLine(line, delimiter)
      .map((p) => stripQuotes(p.trim()))
      .filter((p) => p !== "");

    if (parts.length < 5) continue;

    const parsed = parseRowParts(parts);
    if (!parsed) continue;

    const ts = parsed.ts ?? toUnix(parsed.datePart, parsed.timePart);
    const o = toNum(parsed.open);
    const h = toNum(parsed.high);
    const l = toNum(parsed.low);
    const c = toNum(parsed.close);

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

  return { rows, debug };
}

function parseRowParts(parts) {
  // ISO datetime avec timezone dans la 1re colonne
  // 2026-04-23T12:00:00+00:00,1.16906,1.16981,1.16865,1.16957,3332550000
  if (
    parts[0] &&
    looksLikeIsoDateTime(parts[0]) &&
    isNumeric(parts[1]) &&
    isNumeric(parts[2]) &&
    isNumeric(parts[3]) &&
    isNumeric(parts[4])
  ) {
    const ts = toUnixFromAnyDateTime(parts[0]);
    if (!Number.isFinite(ts)) return null;

    return {
      ts,
      open: parts[1],
      high: parts[2],
      low: parts[3],
      close: parts[4]
    };
  }

  // datetime combiné + OHLC
  if (
    parts[0] &&
    containsDateTime(parts[0]) &&
    isNumeric(parts[1]) &&
    isNumeric(parts[2]) &&
    isNumeric(parts[3]) &&
    isNumeric(parts[4])
  ) {
    const dt = splitDateTimeFlexible(parts[0]);
    if (!dt) return null;

    return {
      datePart: dt.datePart,
      timePart: dt.timePart,
      open: parts[1],
      high: parts[2],
      low: parts[3],
      close: parts[4]
    };
  }

  // date, time, open, high, low, close
  if (
    parts.length >= 6 &&
    looksLikeDate(parts[0]) &&
    looksLikeTime(parts[1]) &&
    isNumeric(parts[2]) &&
    isNumeric(parts[3]) &&
    isNumeric(parts[4]) &&
    isNumeric(parts[5])
  ) {
    return {
      datePart: parts[0],
      timePart: parts[1],
      open: parts[2],
      high: parts[3],
      low: parts[4],
      close: parts[5]
    };
  }

  // timestamp unix + OHLC
  if (
    /^\d{10,13}$/.test(parts[0]) &&
    isNumeric(parts[1]) &&
    isNumeric(parts[2]) &&
    isNumeric(parts[3]) &&
    isNumeric(parts[4])
  ) {
    const ts = normalizeUnixTs(parts[0]);
    if (!Number.isFinite(ts)) return null;

    return {
      ts,
      open: parts[1],
      high: parts[2],
      low: parts[3],
      close: parts[4]
    };
  }

  return null;
}

function splitCsvLine(line, delimiter) {
  const out = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && ch === delimiter) {
      out.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  out.push(current);
  return out;
}

function detectDelimiter(line) {
  const counts = {
    "\t": (line.match(/\t/g) || []).length,
    ";": (line.match(/;/g) || []).length,
    ",": (line.match(/,/g) || []).length
  };

  if (counts["\t"] > counts[";"] && counts["\t"] > counts[","]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

function stripQuotes(value) {
  return String(value).replace(/^"+|"+$/g, "");
}

function looksLikeIsoDateTime(value) {
  const v = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:\d{2})?$/.test(v);
}

function toUnixFromAnyDateTime(value) {
  const ms = Date.parse(String(value).trim());
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

function containsDateTime(value) {
  const v = String(value).trim();
  return (
    (looksLikeDate(v.split(/[ T]/)[0]) && (v.includes(" ") || v.includes("T"))) ||
    /^\d{4}[./-]\d{2}[./-]\d{2}[ T]\d{2}:\d{2}/.test(v)
  );
}

function splitDateTimeFlexible(value) {
  const clean = String(value).trim();

  if (clean.includes("T")) {
    const [datePart, timePart] = clean.split("T", 2);
    return {
      datePart,
      timePart: stripTimezone(stripMilliseconds(timePart))
    };
  }

  if (clean.includes(" ")) {
    const [datePart, timePart] = clean.split(/\s+/, 2);
    return {
      datePart,
      timePart: stripTimezone(stripMilliseconds(timePart))
    };
  }

  return null;
}

function stripMilliseconds(value) {
  return String(value || "").trim().replace(/\.\d+$/, "");
}

function stripTimezone(value) {
  return String(value || "").trim().replace(/Z$/, "").replace(/[+\-]\d{2}:\d{2}$/, "");
}

function normalizeUnixTs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  if (String(value).length === 13) return Math.floor(n / 1000);
  return n;
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
  return /^\d{2}:\d{2}(:\d{2})?(\.\d+)?(?:Z|[+\-]\d{2}:\d{2})?$/.test(v);
}

function looksLikeHeader(line) {
  const lower = line.toLowerCase();
  return (
    lower.includes("date") ||
    lower.includes("time") ||
    lower.includes("open") ||
    lower.includes("high") ||
    lower.includes("low") ||
    lower.includes("close") ||
    lower.includes("utc")
  );
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
  const v = stripTimezone(stripMilliseconds(String(value || "00:00:00").trim()));

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
