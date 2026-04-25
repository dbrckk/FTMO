const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURGBP", "EURJPY", "EURCHF", "EURCAD", "EURAUD", "EURNZD",
  "GBPJPY", "GBPCHF", "GBPCAD", "GBPAUD", "GBPNZD",
  "AUDJPY", "AUDCAD", "AUDCHF", "AUDNZD",
  "NZDJPY", "NZDCAD",
  "XAUUSD"
];

const TIMEFRAME = "M15";
const CANDLE_LIMIT = 200;
const MAX_OPEN_TRADES = 4;
const MIN_OPEN_SCORE = 72;
const EXPLORATION_SCORE = 58;
const DEFAULT_RISK_PERCENT = 0.25;
const EXPLORATION_RISK_PERCENT = 0.1;

export async function onRequestGet(context) {
  return handlePaperRun(context);
}

export async function onRequestPost(context) {
  return handlePaperRun(context);
}

async function handlePaperRun(context) {
  try {
    const env = context.env || {};
    const db = env.DB;
    const secret = env.SYNC_SECRET || env.PAPER_SECRET || "";

    if (!db) {
      return json({ ok: false, error: "Missing DB binding" }, 500);
    }

    if (!isAuthorized(context.request, secret)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    const url = new URL(context.request.url);
    const timeframe = normalizeTimeframe(url.searchParams.get("timeframe")) || TIMEFRAME;

    const archiveStats = await getArchiveStats(db, timeframe);
    const openBefore = await getOpenTrades(db, timeframe);
    const scans = await scanAllPairs(db, timeframe, archiveStats);

    const closed = await updateOpenTrades(db, openBefore, scans);
    const openAfterClose = await getOpenTrades(db, timeframe);
    const opened = await openNewTrades(db, scans, openAfterClose);

    const runId = `paper_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await db
      .prepare(`
        INSERT INTO paper_runs (
          id,
          timeframe,
          scanned_pairs,
          opened,
          closed,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(
        runId,
        timeframe,
        scans.length,
        opened.length,
        closed.length,
        "server-paper-run-with-archive-edge"
      )
      .run();

    return json({
      ok: true,
      source: "server-paper-engine",
      version: "archive-edge-v2",
      runId,
      timeframe,
      scannedPairs: scans.length,
      opened: opened.length,
      closed: closed.length,
      openBefore: openBefore.length,
      openAfter: openAfterClose.length + opened.length,
      topScans: scans.slice(0, 8).map((s) => ({
        pair: s.pair,
        direction: s.direction,
        ultraScore: s.ultraScore,
        archiveEdgeScore: s.archiveEdgeScore,
        archiveConfidence: s.archiveConfidence,
        status: s.status,
        reason: s.reason
      })),
      openedTrades: opened,
      closedTrades: closed
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "paper-run-error")
    }, 500);
  }
}

async function getArchiveStats(db, timeframe) {
  try {
    const res = await db
      .prepare(`
        SELECT
          pair,
          direction,
          pnl_r,
          win,
          session,
          hour,
          closed_at
        FROM paper_trades
        WHERE timeframe = ?
        ORDER BY closed_at DESC
        LIMIT 8000
      `)
      .bind(timeframe)
      .all();

    const rows = Array.isArray(res.results) ? res.results : [];
    return buildArchiveStats(rows);
  } catch {
    return {};
  }
}

function buildArchiveStats(rows) {
  const out = {};

  for (const row of rows) {
    const pair = String(row.pair || "").toUpperCase();
    if (!pair) continue;

    if (!out[pair]) {
      out[pair] = {
        all: [],
        directions: { buy: [], sell: [] },
        sessions: {},
        hours: {},
        last20: []
      };
    }

    const trade = {
      pnlR: Number(row.pnl_r || 0),
      win: Number(row.win || 0) === 1 || Number(row.pnl_r || 0) > 0,
      direction: String(row.direction || "buy").toLowerCase(),
      session: String(row.session || "OffSession"),
      hour: String(Number(row.hour || 0)),
      closedAt: row.closed_at || ""
    };

    out[pair].all.push(trade);
    out[pair].last20 = out[pair].all.slice(0, 20);

    if (out[pair].directions[trade.direction]) {
      out[pair].directions[trade.direction].push(trade);
    }

    if (!out[pair].sessions[trade.session]) {
      out[pair].sessions[trade.session] = [];
    }

    out[pair].sessions[trade.session].push(trade);

    if (!out[pair].hours[trade.hour]) {
      out[pair].hours[trade.hour] = [];
    }

    out[pair].hours[trade.hour].push(trade);
  }

  const packed = {};

  for (const [pair, stat] of Object.entries(out)) {
    packed[pair] = {
      pairTradesCount: stat.all.length,
      pairWinRate: winRate(stat.all),
      pairExpectancy: expectancy(stat.all),
      last20WinRate: winRate(stat.last20),
      last20Expectancy: expectancy(stat.last20),
      archiveConfidence: Math.min(99, stat.all.length),
      directions: {
        buy: packStats(stat.directions.buy),
        sell: packStats(stat.directions.sell)
      },
      sessions: Object.fromEntries(
        Object.entries(stat.sessions).map(([key, value]) => [key, packStats(value)])
      ),
      hours: Object.fromEntries(
        Object.entries(stat.hours).map(([key, value]) => [key, packStats(value)])
      )
    };
  }

  return packed;
}

function packStats(trades) {
  return {
    trades: trades.length,
    winRate: winRate(trades),
    expectancy: expectancy(trades)
  };
}

function winRate(trades) {
  if (!trades.length) return 50;

  const wins = trades.filter((t) => t.win || Number(t.pnlR || 0) > 0).length;
  return Number(((wins / trades.length) * 100).toFixed(2));
}

function expectancy(trades) {
  if (!trades.length) return 0;

  const total = trades.reduce((sum, t) => sum + Number(t.pnlR || 0), 0);
  return Number((total / trades.length).toFixed(4));
}

async function scanAllPairs(db, timeframe, archiveStats) {
  const scans = [];

  for (const pair of PAIRS) {
    const candles = await getCandles(db, pair, timeframe);

    if (candles.length < 40) {
      scans.push({
        pair,
        timeframe,
        status: "SKIPPED",
        reason: "Not enough candles",
        ultraScore: 0,
        archiveEdgeScore: 50,
        archiveConfidence: 0
      });
      continue;
    }

    scans.push(buildScan(pair, timeframe, candles, archiveStats[pair] || null));
  }

  return scans.sort((a, b) => Number(b.ultraScore || 0) - Number(a.ultraScore || 0));
}

async function getCandles(db, pair, timeframe) {
  const res = await db
    .prepare(`
      SELECT ts, open, high, low, close
      FROM market_candles
      WHERE pair = ? AND timeframe = ?
      ORDER BY ts DESC
      LIMIT ?
    `)
    .bind(pair, timeframe, CANDLE_LIMIT)
    .all();

  const rows = Array.isArray(res.results) ? res.results : [];

  return rows
    .map((r) => ({
      time: Number(r.ts || 0),
      open: Number(r.open || 0),
      high: Number(r.high || 0),
      low: Number(r.low || 0),
      close: Number(r.close || 0)
    }))
    .filter((c) =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

function buildScan(pair, timeframe, candles, pairArchiveStats) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const current = closes.at(-1);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(highs, lows, closes, 14);
  const momentum = computeMomentum(closes, 12);
  const macd = ema(closes, 12) - ema(closes, 26);

  const trendScore = clamp(
    50 +
      (ema20 > ema50 ? 18 : -18) +
      (current > ema20 ? 8 : -8) +
      (momentum > 0 ? 8 : -8),
    1,
    99
  );

  const timingScore = clamp(
    50 +
      (rsi14 >= 43 && rsi14 <= 66 ? 14 : -8) +
      (macd > 0 ? 8 : -8),
    1,
    99
  );

  const riskScore = clamp(
    74 -
      (pair === "XAUUSD" ? 8 : 0) -
      (pair.startsWith("GBP") ? 2 : 0),
    1,
    99
  );

  const session = inferSession(new Date());
  const hour = inferHour(new Date());
  const sessionScore = scoreSession();

  const rr = pair === "XAUUSD" ? 2.2 : 2.0;

  const direction =
    trendScore >= 55 && timingScore >= 50
      ? "buy"
      : trendScore <= 45 && timingScore <= 50
        ? "sell"
        : "wait";

  const archive = computeArchiveEdge(pairArchiveStats, direction, session, hour);
  const archiveEdge = archive.archiveEdgeScore;

  let ultraScore = clamp(
    trendScore * 0.25 +
      timingScore * 0.22 +
      riskScore * 0.14 +
      sessionScore * 0.10 +
      archiveEdge * 0.19 +
      clamp(rr * 24, 1, 99) * 0.10,
    1,
    99
  );

  if (pair === "XAUUSD") {
    ultraScore = clamp(
      trendScore * 0.22 +
        timingScore * 0.22 +
        riskScore * 0.10 +
        sessionScore * 0.12 +
        archiveEdge * 0.22 +
        clamp(rr * 28, 1, 99) * 0.12,
      1,
      99
    );
  }

  const riskDistance = atr14 > 0
    ? atr14 * (pair === "XAUUSD" ? 1.55 : 1.4)
    : current * 0.002;

  const stopLoss =
    direction === "sell"
      ? current + riskDistance
      : current - riskDistance;

  const takeProfit =
    direction === "sell"
      ? current - riskDistance * rr
      : current + riskDistance * rr;

  const archiveBad =
    archive.archiveConfidence >= 12 &&
    archive.pairExpectancy < -0.35 &&
    archive.directionExpectancy < -0.25;

  const allowed =
    direction !== "wait" &&
    ultraScore >= MIN_OPEN_SCORE &&
    riskScore >= 45 &&
    !archiveBad;

  return {
    pair,
    timeframe,
    current: roundByPair(current, pair),
    direction,
    signal: direction === "sell" ? "SELL" : direction === "buy" ? "BUY" : "WAIT",
    ultraScore: Math.round(ultraScore),
    trendScore: Math.round(trendScore),
    timingScore: Math.round(timingScore),
    riskScore: Math.round(riskScore),
    sessionScore: Math.round(sessionScore),
    archiveEdgeScore: Math.round(archiveEdge),
    archiveConfidence: archive.archiveConfidence,
    archivePairWinRate: archive.pairWinRate,
    archivePairExpectancy: archive.pairExpectancy,
    archiveDirectionWinRate: archive.directionWinRate,
    archiveDirectionExpectancy: archive.directionExpectancy,
    rsi14: round(rsi14, 2),
    atr14,
    rr,
    stopLoss: roundByPair(stopLoss, pair),
    takeProfit: roundByPair(takeProfit, pair),
    allowed,
    status: allowed ? (pair === "XAUUSD" ? "VALID GOLD SERVER" : "VALID SERVER") : "BLOCKED",
    reason: allowed
      ? "Server setup accepted with archive edge"
      : archiveBad
        ? "Archive expectancy negative"
        : "Not enough confluence"
  };
}

function computeArchiveEdge(stats, direction, session, hour) {
  if (!stats) {
    return {
      archiveEdgeScore: 50,
      archiveConfidence: 0,
      pairWinRate: 50,
      pairExpectancy: 0,
      directionWinRate: 50,
      directionExpectancy: 0
    };
  }

  const dirStats = stats.directions?.[direction] || {};
  const sessionStats = stats.sessions?.[session] || {};
  const hourStats = stats.hours?.[String(hour)] || {};

  const pairWinRate = Number(stats.pairWinRate ?? 50);
  const pairExpectancy = Number(stats.pairExpectancy ?? 0);
  const last20WinRate = Number(stats.last20WinRate ?? 50);
  const last20Expectancy = Number(stats.last20Expectancy ?? 0);

  const directionWinRate = Number(dirStats.winRate ?? 50);
  const directionExpectancy = Number(dirStats.expectancy ?? 0);

  const sessionWinRate = Number(sessionStats.winRate ?? 50);
  const sessionExpectancy = Number(sessionStats.expectancy ?? 0);

  const hourWinRate = Number(hourStats.winRate ?? 50);
  const hourExpectancy = Number(hourStats.expectancy ?? 0);

  const confidence = Number(stats.archiveConfidence || 0);

  const confidenceFactor =
    confidence >= 40 ? 1 :
    confidence >= 25 ? 0.9 :
    confidence >= 12 ? 0.75 :
    confidence >= 6 ? 0.6 :
    0.45;

  const wrScore =
    scoreWinRate(pairWinRate) * 0.20 +
    scoreWinRate(directionWinRate) * 0.22 +
    scoreWinRate(sessionWinRate) * 0.14 +
    scoreWinRate(hourWinRate) * 0.10 +
    scoreWinRate(last20WinRate) * 0.10;

  const expScore =
    scoreExpectancy(pairExpectancy) * 0.12 +
    scoreExpectancy(directionExpectancy) * 0.14 +
    scoreExpectancy(sessionExpectancy) * 0.05 +
    scoreExpectancy(hourExpectancy) * 0.03;

  const raw = wrScore + expScore;

  return {
    archiveEdgeScore: clamp(50 + (raw - 50) * confidenceFactor, 1, 99),
    archiveConfidence: confidence,
    pairWinRate,
    pairExpectancy,
    directionWinRate,
    directionExpectancy
  };
}

function scoreWinRate(winRate) {
  return clamp(50 + (Number(winRate || 50) - 50) * 1.35, 1, 99);
}

function scoreExpectancy(expectancyValue) {
  return clamp(50 + Number(expectancyValue || 0) * 36, 1, 99);
}

async function getOpenTrades(db, timeframe) {
  const res = await db
    .prepare(`
      SELECT *
      FROM paper_open_trades
      WHERE timeframe = ?
      ORDER BY opened_at DESC
    `)
    .bind(timeframe)
    .all();

  return Array.isArray(res.results) ? res.results : [];
}

async function updateOpenTrades(db, openTrades, scans) {
  const closed = [];

  for (const trade of openTrades) {
    const scan = scans.find((s) => s.pair === trade.pair);

    if (!scan || !scan.current) {
      await incrementBarsHeld(db, trade.id);
      continue;
    }

    const price = Number(scan.current);
    const closeResult = shouldCloseTrade(trade, price, scan);

    if (closeResult.close) {
      const closedTrade = buildClosedTrade(trade, closeResult.exitPrice, closeResult.reason, scan);
      await insertClosedTrade(db, closedTrade);
      await deleteOpenTrade(db, trade.id);
      closed.push(closedTrade);
    } else {
      await db
        .prepare(`
          UPDATE paper_open_trades
          SET current_price = ?, bars_held = bars_held + 1
          WHERE id = ?
        `)
        .bind(price, trade.id)
        .run();
    }
  }

  return closed;
}

function shouldCloseTrade(trade, price, scan) {
  const direction = String(trade.direction || "buy").toLowerCase();
  const stop = Number(trade.stop_loss || 0);
  const target = Number(trade.take_profit || 0);
  const barsHeld = Number(trade.bars_held || 0);
  const maxBars = Number(trade.max_bars_hold || 12);

  if (direction === "buy") {
    if (price <= stop) return { close: true, reason: "stop-loss", exitPrice: stop };
    if (price >= target) return { close: true, reason: "take-profit", exitPrice: target };
  } else {
    if (price >= stop) return { close: true, reason: "stop-loss", exitPrice: stop };
    if (price <= target) return { close: true, reason: "take-profit", exitPrice: target };
  }

  if (barsHeld >= maxBars) {
    return { close: true, reason: "time-exit", exitPrice: price };
  }

  if (Number(scan.ultraScore || 0) < 52) {
    return { close: true, reason: "signal-decay", exitPrice: price };
  }

  return { close: false };
}

async function openNewTrades(db, scans, currentOpenTrades) {
  const opened = [];
  const openPairs = new Set(currentOpenTrades.map((t) => t.pair));

  if (currentOpenTrades.length >= MAX_OPEN_TRADES) return opened;

  const candidates = scans
    .filter((s) => s.allowed)
    .filter((s) => s.direction === "buy" || s.direction === "sell")
    .filter((s) => !openPairs.has(s.pair))
    .sort((a, b) => Number(b.ultraScore || 0) - Number(a.ultraScore || 0));

  for (const scan of candidates) {
    if (currentOpenTrades.length + opened.length >= MAX_OPEN_TRADES) break;

    const trade = createOpenTrade(scan, false);
    await insertOpenTrade(db, trade);
    opened.push(trade);
    openPairs.add(scan.pair);
  }

  if (!opened.length && currentOpenTrades.length === 0) {
    const exploration = scans
      .filter((s) => !openPairs.has(s.pair))
      .filter((s) => s.direction === "buy" || s.direction === "sell")
      .filter((s) => Number(s.ultraScore || 0) >= EXPLORATION_SCORE)
      .sort((a, b) => Number(b.ultraScore || 0) - Number(a.ultraScore || 0))[0];

    if (exploration) {
      const trade = createOpenTrade(exploration, true);
      await insertOpenTrade(db, trade);
      opened.push(trade);
    }
  }

  return opened;
}

function createOpenTrade(scan, exploration = false) {
  const now = new Date();
  const riskPercent = exploration ? EXPLORATION_RISK_PERCENT : DEFAULT_RISK_PERCENT;

  return {
    id: `server_paper_${Date.now()}_${scan.pair}_${Math.random().toString(36).slice(2, 8)}`,
    pair: scan.pair,
    timeframe: scan.timeframe,
    direction: scan.direction,
    openedAt: now.toISOString(),
    entry: scan.current,
    stopLoss: scan.stopLoss,
    takeProfit: scan.takeProfit,
    currentPrice: scan.current,
    riskPercent,
    rr: scan.rr,
    barsHeld: 0,
    maxBarsHold: exploration ? 8 : 12,
    ultraScore: scan.ultraScore,
    mlScore: 50,
    archiveEdgeScore: scan.archiveEdgeScore,
    session: inferSession(now),
    hour: inferHour(now),
    modelTag: exploration ? "SERVER_EXPLORATION" : scan.status,
    source: "server-paper"
  };
}

async function insertOpenTrade(db, trade) {
  await db
    .prepare(`
      INSERT OR REPLACE INTO paper_open_trades (
        id,
        pair,
        timeframe,
        direction,
        opened_at,
        entry,
        stop_loss,
        take_profit,
        current_price,
        risk_percent,
        rr,
        bars_held,
        max_bars_hold,
        ultra_score,
        ml_score,
        archive_edge_score,
        session,
        hour,
        model_tag,
        source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      trade.id,
      trade.pair,
      trade.timeframe,
      trade.direction,
      trade.openedAt,
      trade.entry,
      trade.stopLoss,
      trade.takeProfit,
      trade.currentPrice,
      trade.riskPercent,
      trade.rr,
      trade.barsHeld,
      trade.maxBarsHold,
      trade.ultraScore,
      trade.mlScore,
      trade.archiveEdgeScore,
      trade.session,
      trade.hour,
      trade.modelTag,
      trade.source
    )
    .run();
}

function buildClosedTrade(trade, exitPrice, reason, scan) {
  const entry = Number(trade.entry || 0);
  const stop = Number(trade.stop_loss || 0);
  const riskDistance = Math.abs(entry - stop);
  const direction = String(trade.direction || "buy").toLowerCase();

  let pnlR = 0;

  if (riskDistance > 0) {
    pnlR =
      direction === "buy"
        ? (Number(exitPrice) - entry) / riskDistance
        : (entry - Number(exitPrice)) / riskDistance;
  }

  const capital = 10000;
  const riskAmount = capital * (Number(trade.risk_percent || DEFAULT_RISK_PERCENT) / 100);
  const pnl = pnlR * riskAmount;

  return {
    id: trade.id,
    pair: trade.pair,
    timeframe: trade.timeframe,
    direction,
    openedAt: trade.opened_at,
    closedAt: new Date().toISOString(),
    entry,
    exitPrice: roundByPair(exitPrice, trade.pair),
    stopLoss: Number(trade.stop_loss || 0),
    takeProfit: Number(trade.take_profit || 0),
    pnl: round(pnl, 2),
    pnlR: round(pnlR, 3),
    win: pnlR > 0 ? 1 : 0,
    session: trade.session || inferSession(new Date()),
    hour: Number(trade.hour || inferHour(new Date())),
    ultraScore: Number(trade.ultra_score || scan?.ultraScore || 0),
    mlScore: Number(trade.ml_score || 50),
    vectorbtScore: 50,
    archiveEdgeScore: Number(trade.archive_edge_score || scan?.archiveEdgeScore || 50),
    closeReason: reason,
    source: "server-paper"
  };
}

async function insertClosedTrade(db, trade) {
  await db
    .prepare(`
      INSERT OR REPLACE INTO paper_trades (
        id,
        pair,
        timeframe,
        direction,
        opened_at,
        closed_at,
        entry,
        exit,
        stop_loss,
        take_profit,
        pnl,
        pnl_r,
        win,
        session,
        hour,
        ultra_score,
        ml_score,
        vectorbt_score,
        archive_edge_score,
        close_reason,
        source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      trade.id,
      trade.pair,
      trade.timeframe,
      trade.direction,
      trade.openedAt,
      trade.closedAt,
      trade.entry,
      trade.exitPrice,
      trade.stopLoss,
      trade.takeProfit,
      trade.pnl,
      trade.pnlR,
      trade.win,
      trade.session,
      trade.hour,
      trade.ultraScore,
      trade.mlScore,
      trade.vectorbtScore,
      trade.archiveEdgeScore,
      trade.closeReason,
      trade.source
    )
    .run();
}

async function deleteOpenTrade(db, id) {
  await db
    .prepare(`DELETE FROM paper_open_trades WHERE id = ?`)
    .bind(id)
    .run();
}

async function incrementBarsHeld(db, id) {
  await db
    .prepare(`
      UPDATE paper_open_trades
      SET bars_held = bars_held + 1
      WHERE id = ?
    `)
    .bind(id)
    .run();
}

function isAuthorized(request, secret) {
  if (!secret) return true;

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  return token === secret || bearer === secret;
}

function ema(values, period) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;

  const k = 2 / (period + 1);
  let prev = nums[0];

  for (let i = 1; i < nums.length; i += 1) {
    prev = nums[i] * k + prev * (1 - k);
  }

  return prev;
}

function rsi(values, period = 14) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = nums.length - period; i < nums.length; i += 1) {
    const diff = nums[i] - nums[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0 && gains === 0) return 50;
  if (losses === 0) return 100;

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function atr(highs, lows, closes, period = 14) {
  if (highs.length < 2) return 0;

  const trs = [];

  for (let i = 1; i < highs.length; i += 1) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }

  const recent = trs.slice(-period);
  if (!recent.length) return 0;

  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function computeMomentum(values, lookback = 12) {
  if (values.length <= lookback) return 0;

  const current = values.at(-1);
  const past = values.at(-1 - lookback);

  if (!past) return 0;

  return ((current - past) / past) * 100;
}

function scoreSession() {
  const hour = inferHour(new Date());

  if (hour >= 14 && hour < 18) return 68;
  if (hour >= 9 && hour < 14) return 62;
  if (hour >= 18 && hour < 21) return 56;
  if (hour >= 1 && hour < 8) return 52;

  return 44;
}

function inferSession(date = new Date()) {
  const hour = inferHour(date);

  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const tokyo = hour >= 1 && hour < 10;

  if (london && newYork) return "London+NewYork";
  if (london) return "London";
  if (newYork) return "NewYork";
  if (tokyo) return "Tokyo";

  return "OffSession";
}

function inferHour(date = new Date()) {
  return Number(
    new Date(date).toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );
}

function normalizeTimeframe(value) {
  const tf = String(value || "").toUpperCase().trim();
  return ["M5", "M15", "H1", "H4"].includes(tf) ? tf : "";
}

function roundByPair(value, pair) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  if (pair === "XAUUSD") return Number(n.toFixed(2));
  if (String(pair).includes("JPY")) return Number(n.toFixed(3));

  return Number(n.toFixed(5));
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function clamp(value, min = 1, max = 99) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
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
