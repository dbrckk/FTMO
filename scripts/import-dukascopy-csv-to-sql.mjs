import fs from "node:fs";
import path from "node:path";

const INPUT_DIR = path.resolve("seed/dukascopy");
const OUTPUT_FILE = path.resolve("seed/market_candles.sql");

const ALLOWED_TIMEFRAMES = new Set(["M5", "M15", "H1", "H4"]);
const BATCH_SIZE = 500;

main();

function main() {
  if (!fs.existsSync(INPUT_DIR)) {
    throw new Error(`Missing folder: ${INPUT_DIR}`);
  }

  const files = fs.readdirSync(INPUT_DIR).filter((f) => f.toLowerCase().endsWith(".csv"));
  if (!files.length) {
    throw new Error(`No CSV files found in ${INPUT_DIR}`);
  }

  const allRows = [];

  for (const file of files) {
    const meta = parseFileName(file);
    if (!meta) {
      console.warn(`Skipping file with invalid name: ${file}`);
      continue;
    }

    const fullPath = path.join(INPUT_DIR, file);
    const raw = fs.readFileSync(fullPath, "utf8");
    const rows = parseCsv(raw, meta.pair, meta.timeframe);

    console.log(`${file}: ${rows.length} rows parsed`);
    allRows.push(...rows);
  }

  if (!allRows.length) {
    throw new Error("No rows parsed from CSV files.");
  }

  const deduped = dedupeRows(allRows);
  const sql = buildSql(deduped);

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, sql, "utf8");

  console.log(`Done. ${deduped.length} rows written to ${OUTPUT_FILE}`);
}

function parseFileName(file) {
  const base = file.replace(/\.csv$/i, "");
  const match = base.match(/^([A-Z0-9]+)_(M5|M15|H1|H4)$/);
  if (!match) return null;

  const pair = match[1].toUpperCase();
  const timeframe = match[2].toUpperCase();

  if (!ALLOWED_TIMEFRAMES.has(timeframe)) return null;

  return { pair, timeframe };
}

function parseCsv(raw, pair, timeframe) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const rows = [];
  const source = "dukascopy";

  for (const line of lines) {
    if (looksLikeHeader(line)) continue;

    const delimiter = line.includes(";") ? ";" : ",";
    const parts = line.split(delimiter).map((p) => p.trim());

    if (parts.length < 5) continue;

    let datePart = "";
    let timePart = "";
    let open, high, low, close;

    if (parts.length >= 6) {
      datePart = parts[0];
      timePart = parts[1];
      open = parts[2];
      high = parts[3];
      low = parts[4];
      close = parts[5];
    } else {
      const dt = parts[0];
      const split = splitDateTime(dt);
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

    if (!Number.isFinite(ts) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
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
      source
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

  return [...map.values()].sort((a, b) => {
    if (a.pair !== b.pair) return a.pair.localeCompare(b.pair);
    if (a.timeframe !== b.timeframe) return a.timeframe.localeCompare(b.timeframe);
    return a.ts - b.ts;
  });
}

function esc(value) {
  return String(value).replace(/'/g, "''");
}

function buildSql(rows) {
  const chunks = [];

  chunks.push("BEGIN TRANSACTION;");
  chunks.push(`
CREATE TABLE IF NOT EXISTS market_candles (
  pair TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  source TEXT,
  PRIMARY KEY (pair, timeframe, ts)
);`.trim());

  chunks.push(`
CREATE INDEX IF NOT EXISTS idx_market_candles_pair_tf_ts
ON market_candles(pair, timeframe, ts DESC);`.trim());

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const values = batch.map((r) => {
      return `('${esc(r.pair)}','${esc(r.timeframe)}',${r.ts},${r.open},${r.high},${r.low},${r.close},'${esc(r.source)}')`;
    });

    chunks.push(`
INSERT OR REPLACE INTO market_candles
(pair, timeframe, ts, open, high, low, close, source)
VALUES
${values.join(",\n")};`.trim());
  }

  chunks.push("COMMIT;");
  chunks.push("");

  return chunks.join("\n\n");
      }
