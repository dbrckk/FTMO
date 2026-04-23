import { clamp } from "./utils.js";

/* ============================= */
/* TIME / SESSION */
/* ============================= */

export function getSessionMeta() {
  const now = new Date();

  const hour = Number(
    now.toLocaleString("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    })
  );

  const london = hour >= 9 && hour < 18;
  const newYork = hour >= 14 && hour < 23;
  const overlap = london && newYork;
  const asia = hour >= 1 && hour < 10;

  let label = "OffSession";
  if (overlap) label = "London+NewYork";
  else if (london) label = "London";
  else if (newYork) label = "NewYork";
  else if (asia) label = "Tokyo";

  return {
    hour,
    london,
    newYork,
    overlap,
    asia,
    label
  };
}

export function computeSessionScore(scan) {
  const meta = getSessionMeta();

  if (scan.pair === "XAUUSD") {
    if (meta.overlap) return 96;
    if (meta.newYork) return 88;
    if (meta.london) return 84;
    if (meta.asia) return 38;
    return 30;
  }

  if (meta.overlap) return 92;
  if (meta.london) return 78;
  if (meta.newYork) return 76;
  if (meta.asia && scan.pair?.includes("JPY")) return 70;
  if (meta.asia) return 48;

  return 42;
}

/* ============================= */
/* SPREAD / VOLATILITY / ENTRY */
/* ============================= */

export function computeSpreadPenalty(scan) {
  const spreadPips = Number(scan.spreadPips || 0);
  const spreadPctAtr = Number(scan.spreadPctAtr || 0);

  let penalty = 0;

  if (spreadPips > 0.8) penalty += 8;
  if (spreadPips > 1.5) penalty += 10;
  if (spreadPctAtr > 0.10) penalty += 10;
  if (spreadPctAtr > 0.18) penalty += 12;

  if (scan.pair === "XAUUSD") {
    if (spreadPips > 15) penalty += 10;
    if (spreadPctAtr > 0.12) penalty += 10;
  }

  return clamp(100 - penalty, 1, 99);
}

export function computeEntryPrecisionScore(scan) {
  const current = Number(scan.current || 0);
  const ema20 = Number(scan.ema20 || current);
  const ema50 = Number(scan.ema50 || current);
  const atr14 = Number(scan.atr14 || 0);

  if (!current || !atr14) return 50;

  const distToEma20 = Math.abs(current - ema20) / atr14;
  const distToEma50 = Math.abs(current - ema50) / atr14;

  let score = 50;

  if (distToEma20 <= 0.35) score += 14;
  else if (distToEma20 <= 0.70) score += 7;
  else score -= 10;

  if (distToEma50 <= 0.90) score += 6;
  else score -= 4;

  if ((scan.entryTriggerScore || 0) >= 65) score += 8;
  if ((scan.entrySniper?.score || 0) >= 70) score += 10;

  if ((scan.rr || 0) >= 2) score += 7;
  else if ((scan.rr || 0) < 1.4) score -= 10;

  return clamp(score, 1, 99);
}

export function computeMomentumQuality(scan) {
  let score = 50;

  if ((scan.momentum || 0) > 0) score += 8;
  else score -= 8;

  if ((scan.macdLine || 0) > 0) score += 8;
  else score -= 8;

  if ((scan.rsi14 || 50) > 45 && (scan.rsi14 || 50) < 65) score += 8;
  else score -= 6;

  return clamp(score, 1, 99);
}

/* ============================= */
/* GOLD SPECIAL */
/* ============================= */

export function computeGoldStructureScore(scan) {
  if (scan.pair !== "XAUUSD") return 50;

  let score = 50;

  if ((scan.ema20 || 0) > (scan.ema50 || 0)) score += 10;
  else score -= 10;

  if ((scan.momentum || 0) > 0) score += 8;
  else score -= 8;

  if ((scan.rsi14 || 50) >= 48 && (scan.rsi14 || 50) <= 64) score += 10;
  else score -= 8;

  if ((scan.rr || 0) >= 2) score += 10;
  else if ((scan.rr || 0) < 1.5) score -= 10;

  if ((scan.entrySniper?.score || 0) >= 70) score += 8;

  return clamp(score, 1, 99);
}

export function computeGoldDangerScore(scan) {
  if (scan.pair !== "XAUUSD") return 20;

  let danger = 20;

  if ((scan.sessionScore || 0) < 55) danger += 20;
  if ((scan.spreadScore || 100) < 60) danger += 20;
  if ((scan.riskScore || 0) < 45) danger += 16;
  if ((scan.archiveEdgeScore || 50) < 50) danger += 16;

  return clamp(danger, 1, 99);
}

/* ============================= */
/* ARCHIVE EDGE */
/* ============================= */

export function computeArchiveEdgeScore(scan) {
  const a = scan.archiveStats || null;
  if (!a) return 50;

  const pairWinRate = Number(a.pairWinRate ?? 50);
  const pairExpectancy = Number(a.pairExpectancy ?? 0);
  const hourWinRate = Number(a.hourWinRate ?? 50);
  const hourExpectancy = Number(a.hourExpectancy ?? 0);
  const sessionWinRate = Number(a.sessionWinRate ?? 50);
  const sessionExpectancy = Number(a.sessionExpectancy ?? 0);
  const last20WinRate = Number(a.last20WinRate ?? 50);
  const sameDirectionWinRate = Number(a.sameDirectionWinRate ?? 50);
  const sameDirectionExpectancy = Number(a.sameDirectionExpectancy ?? 0);

  let score = 50;

  score += (pairWinRate - 50) * 0.35;
  score += (hourWinRate - 50) * 0.20;
  score += (sessionWinRate - 50) * 0.20;
  score += (last20WinRate - 50) * 0.10;
  score += (sameDirectionWinRate - 50) * 0.15;

  score += pairExpectancy * 12;
  score += hourExpectancy * 8;
  score += sessionExpectancy * 8;
  score += sameDirectionExpectancy * 10;

  return clamp(Math.round(score), 1, 99);
}

/* ============================= */
/* SMART MONEY / EXECUTION */
/* ============================= */

export function computeSmartMoneyScore(scan) {
  let score = 50;

  if ((scan.ema20 || 0) > (scan.ema50 || 0)) score += 12;
  else score -= 12;

  if ((scan.momentum || 0) > 0) score += 8;
  else score -= 8;

  if ((scan.rsi14 || 50) > 45 && (scan.rsi14 || 50) < 65) score += 10;
  else score -= 6;

  if ((scan.rr || 0) >= 2) score += 8;
  else if ((scan.rr || 0) < 1.4) score -= 8;

  if ((scan.entrySniper?.score || 0) >= 70) score += 8;

  return clamp(score, 1, 99);
}

export function computeExecutionScore(scan) {
  let score = 50;

  if ((scan.trendScore || 0) >= 70) score += 8;
  if ((scan.timingScore || 0) >= 70) score += 8;
  if ((scan.mlScore || 0) >= 70) score += 8;
  if ((scan.vectorbtScore || 0) >= 70) score += 8;

  if ((scan.riskScore || 0) < 45) score -= 10;
  if ((scan.contextScore || 0) < 45) score -= 10;

  if ((scan.entryPrecisionScore || 50) >= 70) score += 8;
  if ((scan.momentumQuality || 50) >= 70) score += 6;

  return clamp(score, 1, 99);
}

/* ============================= */
/* ULTRA SCORE */
/* ============================= */

export function computeUltraScore(scan) {
  const sessionScore = computeSessionScore(scan);
  const smartMoneyScore = computeSmartMoneyScore(scan);
  const entryPrecisionScore = computeEntryPrecisionScore(scan);
  const momentumQuality = computeMomentumQuality(scan);
  const spreadScore = computeSpreadPenalty(scan);
  const archiveEdgeScore = computeArchiveEdgeScore(scan);
  const goldStructureScore = computeGoldStructureScore(scan);

  const enriched = {
    ...scan,
    sessionScore,
    smartMoneyScore,
    entryPrecisionScore,
    momentumQuality,
    spreadScore,
    archiveEdgeScore,
    goldStructureScore
  };

  const executionScore = computeExecutionScore(enriched);

  let ultraScore;

  if (scan.pair === "XAUUSD") {
    ultraScore = Math.round(
      (scan.finalScore || 0) * 0.22 +
      smartMoneyScore * 0.12 +
      sessionScore * 0.16 +
      executionScore * 0.14 +
      entryPrecisionScore * 0.12 +
      archiveEdgeScore * 0.14 +
      goldStructureScore * 0.10
    );
  } else {
    ultraScore = Math.round(
      (scan.finalScore || 0) * 0.34 +
      smartMoneyScore * 0.14 +
      sessionScore * 0.12 +
      executionScore * 0.14 +
      entryPrecisionScore * 0.10 +
      archiveEdgeScore * 0.16
    );
  }

  return {
    ultraScore: clamp(ultraScore, 1, 99),
    smartMoney: smartMoneyScore,
    session: sessionScore,
    execution: executionScore,
    entryPrecision: entryPrecisionScore,
    momentumQuality,
    spreadScore,
    archiveEdge: archiveEdgeScore,
    goldStructure: goldStructureScore,
    goldDanger: computeGoldDangerScore({
      ...scan,
      sessionScore,
      spreadScore,
      archiveEdgeScore
    }),
    grade:
      ultraScore >= 90 ? "A+" :
      ultraScore >= 82 ? "A" :
      ultraScore >= 72 ? "B" :
      ultraScore >= 62 ? "C" :
      "D"
  };
}

/* ============================= */
/* FTMO-FIRST DECISION */
/* ============================= */

export function getTradeFilterDecision(scan) {
  const ultra = computeUltraScore(scan);

  if ((scan.mlScore || 0) < 45) {
    return {
      allowed: false,
      status: "BLOCKED",
      reason: "ML score too low",
      ultra
    };
  }

  if ((scan.vectorbtScore || 0) < 45) {
    return {
      allowed: false,
      status: "BLOCKED",
      reason: "VectorBT score too low",
      ultra
    };
  }

  if ((scan.riskScore || 0) < 40) {
    return {
      allowed: false,
      status: "BLOCKED",
      reason: "Risk score too low",
      ultra
    };
  }

  if ((ultra.spreadScore || 0) < 45) {
    return {
      allowed: false,
      status: "BLOCKED",
      reason: "Spread quality too low",
      ultra
    };
  }

  if ((ultra.archiveEdge || 0) < 42) {
    return {
      allowed: false,
      status: "BLOCKED",
      reason: "Archive edge too low",
      ultra
    };
  }

  if (scan.pair === "XAUUSD") {
    if ((ultra.session || 0) < 60) {
      return {
        allowed: false,
        status: "BLOCKED",
        reason: "Gold outside premium session",
        ultra
      };
    }

    if ((ultra.goldDanger || 0) >= 65) {
      return {
        allowed: false,
        status: "BLOCKED",
        reason: "Gold danger too high",
        ultra
      };
    }

    if (ultra.ultraScore >= 84) {
      return {
        allowed: true,
        status: "SNIPER GOLD",
        reason: "High-quality gold setup with archive confirmation",
        ultra
      };
    }

    if (ultra.ultraScore >= 72) {
      return {
        allowed: true,
        status: "VALID GOLD",
        reason: "Gold setup acceptable with controlled risk",
        ultra
      };
    }

    return {
      allowed: false,
      status: "BLOCKED",
      reason: "Gold ultra score too low",
      ultra
    };
  }

  if (ultra.ultraScore >= 80) {
    return {
      allowed: true,
      status: "SNIPER",
      reason: "High probability setup",
      ultra
    };
  }

  if (ultra.ultraScore >= 68) {
    return {
      allowed: true,
      status: "VALID",
      reason: "Acceptable setup with controlled risk",
      ultra
    };
  }

  return {
    allowed: false,
    status: "BLOCKED",
    reason: "Ultra score too low",
    ultra
  };
                       }
