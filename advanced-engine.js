function clamp(value, min = 1, max = 99) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pctScore(winRate, neutral = 50) {
  const wr = num(winRate, neutral);
  return clamp(50 + (wr - 50) * 1.4, 1, 99);
}

function expectancyScore(expectancy) {
  const exp = num(expectancy, 0);
  return clamp(50 + exp * 35, 1, 99);
}

function archiveConfidenceFactor(confidence) {
  const c = num(confidence, 0);
  if (c >= 30) return 1;
  if (c >= 20) return 0.9;
  if (c >= 12) return 0.8;
  if (c >= 6) return 0.65;
  return 0.5;
}

function scoreArchiveEdge(scan) {
  const stats = scan.archiveStats || {};
  const confidence = archiveConfidenceFactor(stats.archiveConfidence);

  const pairWR = pctScore(stats.pairWinRate, 50);
  const pairExp = expectancyScore(stats.pairExpectancy);
  const sessionWR = pctScore(stats.sessionWinRate, 50);
  const sessionExp = expectancyScore(stats.sessionExpectancy);
  const hourWR = pctScore(stats.hourWinRate, 50);
  const hourExp = expectancyScore(stats.hourExpectancy);
  const dirWR = pctScore(stats.sameDirectionWinRate, 50);
  const dirExp = expectancyScore(stats.sameDirectionExpectancy);
  const last20 = pctScore(stats.last20WinRate, 50);

  const raw =
    pairWR * 0.18 +
    pairExp * 0.18 +
    sessionWR * 0.12 +
    sessionExp * 0.10 +
    hourWR * 0.08 +
    hourExp * 0.06 +
    dirWR * 0.16 +
    dirExp * 0.08 +
    last20 * 0.04;

  return clamp(50 + (raw - 50) * confidence, 1, 99);
}

function scoreSession(scan) {
  const stats = scan.archiveStats || {};
  const base =
    num(scan.contextScore, 50) * 0.28 +
    pctScore(stats.sessionWinRate, 50) * 0.28 +
    expectancyScore(stats.sessionExpectancy) * 0.20 +
    pctScore(stats.hourWinRate, 50) * 0.14 +
    expectancyScore(stats.hourExpectancy) * 0.10;

  return clamp(base, 1, 99);
}

function scoreSmartMoney(scan) {
  const momentumBonus = num(scan.momentum, 0) > 0 ? 6 : -6;
  const emaBias = num(scan.ema20, 0) > num(scan.ema50, 0) ? 8 : -8;

  return clamp(
    num(scan.trendScore, 50) * 0.42 +
      num(scan.contextScore, 50) * 0.18 +
      num(scan.timingScore, 50) * 0.18 +
      50 +
      momentumBonus +
      emaBias,
    1,
    99
  );
}

function scoreExecution(scan) {
  const rrScore = clamp(num(scan.rr, 1.2) * 22, 1, 99);
  const trigger = num(scan.entryTriggerScore, 50);
  const sniper = num(scan.entrySniper?.score, 50);

  return clamp(
    rrScore * 0.24 +
      num(scan.timingScore, 50) * 0.30 +
      trigger * 0.18 +
      sniper * 0.18 +
      num(scan.riskScore, 50) * 0.10,
    1,
    99
  );
}

function scoreEntryPrecision(scan) {
  return clamp(
    num(scan.timingScore, 50) * 0.42 +
      num(scan.entryTriggerScore, 50) * 0.25 +
      num(scan.entrySniper?.score, 50) * 0.23 +
      num(scan.mlScore, 50) * 0.10,
    1,
    99
  );
}

function scoreMomentumQuality(scan) {
  const positive = num(scan.momentum, 0) > 0 ? 1 : 0;
  return clamp(
    num(scan.trendScore, 50) * 0.40 +
      num(scan.timingScore, 50) * 0.35 +
      (positive ? 70 : 35) * 0.25,
    1,
    99
  );
}

function scoreSpread(scan) {
  const penalty =
    num(scan.spreadPenalty, 0) * 1.4 +
    num(scan.offSessionPenalty, 0) * 0.9 +
    num(scan.macroPenalty, 0) * 0.8;

  return clamp(78 - penalty, 1, 99);
}

function scoreGoldStructure(scan, archiveEdge, sessionScore) {
  if (scan.pair !== "XAUUSD") return 50;

  const rrScore = clamp(num(scan.rr, 1.2) * 20, 1, 99);

  return clamp(
    num(scan.trendScore, 50) * 0.24 +
      num(scan.timingScore, 50) * 0.18 +
      num(scan.executionScore, 50) * 0.14 +
      archiveEdge * 0.18 +
      sessionScore * 0.12 +
      rrScore * 0.14,
    1,
    99
  );
}

function scoreGoldDanger(scan, archiveEdge, sessionScore) {
  if (scan.pair !== "XAUUSD") return 35;

  const mlDanger = num(scan.mlScore, 50) < 35 ? 18 : 0;
  const riskDanger = num(scan.riskScore, 50) < 40 ? 16 : 0;
  const sessionDanger = sessionScore < 50 ? 14 : 0;
  const archiveDanger = archiveEdge < 48 ? 18 : 0;
  const timingDanger = num(scan.timingScore, 50) < 42 ? 12 : 0;

  return clamp(12 + mlDanger + riskDanger + sessionDanger + archiveDanger + timingDanger, 1, 99);
}

function scoreMlAdjusted(scan, archiveEdge, sessionScore) {
  const ml = num(scan.mlScore, 50);

  if (scan.pair !== "XAUUSD") return ml;

  if (ml >= 50) return ml;
  if (archiveEdge >= 65 || sessionScore >= 68) return clamp(ml + 10, 1, 99);
  if (archiveEdge >= 58 || sessionScore >= 60) return clamp(ml + 6, 1, 99);
  return ml;
}

export function computeUltraScore(scan) {
  const archiveEdge = scoreArchiveEdge(scan);
  const session = scoreSession(scan);
  const smartMoney = scoreSmartMoney(scan);
  const execution = scoreExecution(scan);
  const entryPrecision = scoreEntryPrecision(scan);
  const momentumQuality = scoreMomentumQuality(scan);
  const spreadScore = scoreSpread(scan);
  const mlAdjusted = scoreMlAdjusted(scan, archiveEdge, session);

  scan.executionScore = execution;

  const goldStructure = scoreGoldStructure(scan, archiveEdge, session);
  const goldDanger = scoreGoldDanger(scan, archiveEdge, session);

  let ultraScore =
    smartMoney * 0.20 +
    session * 0.16 +
    execution * 0.16 +
    entryPrecision * 0.12 +
    momentumQuality * 0.10 +
    spreadScore * 0.06 +
    archiveEdge * 0.12 +
    mlAdjusted * 0.04 +
    num(scan.vectorbtScore, 50) * 0.04;

  if (scan.pair === "XAUUSD") {
    ultraScore =
      smartMoney * 0.16 +
      session * 0.16 +
      execution * 0.14 +
      entryPrecision * 0.10 +
      momentumQuality * 0.08 +
      archiveEdge * 0.18 +
      goldStructure * 0.14 +
      mlAdjusted * 0.02 +
      num(scan.vectorbtScore, 50) * 0.02;
  }

  ultraScore = clamp(Math.round(ultraScore), 1, 99);

  const grade =
    ultraScore >= 85 ? "A+" :
    ultraScore >= 78 ? "A" :
    ultraScore >= 70 ? "B+" :
    ultraScore >= 62 ? "B" :
    ultraScore >= 55 ? "C" : "D";

  return {
    ultraScore,
    grade,
    smartMoney: Math.round(smartMoney),
    session: Math.round(session),
    execution: Math.round(execution),
    entryPrecision: Math.round(entryPrecision),
    momentumQuality: Math.round(momentumQuality),
    spreadScore: Math.round(spreadScore),
    archiveEdge: Math.round(archiveEdge),
    goldStructure: Math.round(goldStructure),
    goldDanger: Math.round(goldDanger)
  };
}

export function getTradeFilterDecision(scan) {
  const isGold = scan.pair === "XAUUSD";
  const ultra = num(scan.ultraScore, 0);
  const ml = num(scan.mlScore, 50);
  const archiveEdge = num(scan.archiveEdgeScore, 50);
  const session = num(scan.sessionScore, 50);
  const execution = num(scan.executionScore, 50);
  const goldStructure = num(scan.goldStructureScore, 50);
  const goldDanger = num(scan.goldDangerScore, 35);
  const risk = num(scan.riskScore, 50);
  const finalScore = num(scan.finalScore, 50);
  const stats = scan.archiveStats || {};
  const archiveConfidence = num(stats.archiveConfidence, 0);
  const pairExpectancy = num(stats.pairExpectancy, 0);
  const dirExpectancy = num(stats.sameDirectionExpectancy, 0);

  if (risk < 28) {
    return { allowed: false, status: "BLOCKED", reason: "Risk score too low" };
  }

  if (finalScore < 46 && ultra < 52) {
    return { allowed: false, status: "BLOCKED", reason: "Global score too weak" };
  }

  if (!isGold && ml < 24 && archiveEdge < 60) {
    return { allowed: false, status: "BLOCKED", reason: "ML score too low" };
  }

  if (archiveConfidence >= 12 && pairExpectancy < -0.40 && dirExpectancy < -0.25) {
    return { allowed: false, status: "BLOCKED", reason: "Archive expectancy too weak" };
  }

  if (isGold) {
    if (goldDanger >= 70) {
      return { allowed: false, status: "BLOCKED GOLD", reason: "Gold danger too high" };
    }

    if (ultra >= 80 && goldStructure >= 72 && archiveEdge >= 56 && session >= 58) {
      return { allowed: true, status: "SNIPER GOLD", reason: "Gold structure + archive + session aligned" };
    }

    if (
      ultra >= 68 &&
      goldStructure >= 62 &&
      goldDanger <= 56 &&
      (ml >= 32 || archiveEdge >= 60 || session >= 64)
    ) {
      return { allowed: true, status: "VALID GOLD", reason: "Gold acceptable through archive/session confirmation" };
    }

    if (ultra >= 60 && (archiveEdge >= 58 || session >= 60)) {
      return { allowed: false, status: "WATCH GOLD", reason: "Promising gold setup but not clean enough" };
    }

    return { allowed: false, status: "BLOCKED GOLD", reason: "Gold setup not confirmed" };
  }

  if (ultra >= 82 && archiveEdge >= 58 && execution >= 60) {
    return { allowed: true, status: "SNIPER", reason: "High-quality multi-factor setup" };
  }

  if (
    ultra >= 68 &&
    session >= 54 &&
    execution >= 52 &&
    (ml >= 36 || archiveEdge >= 62)
  ) {
    return { allowed: true, status: "VALID", reason: "Archive and execution confirm the trade" };
  }

  if (ultra >= 58 && archiveEdge >= 58) {
    return { allowed: false, status: "WATCH", reason: "Archive decent but execution still weak" };
  }

  if (ml < 30) {
    return { allowed: false, status: "BLOCKED", reason: "ML score too low" };
  }

  return { allowed: false, status: "BLOCKED", reason: "Not enough confluence" };
    }
