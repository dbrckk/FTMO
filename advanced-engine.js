// advanced-engine.js
// MODULE BONUS → améliore ton edge (filtrage institutionnel + scoring avancé)

import { clamp } from "./utils.js";

/* ============================= */
/* SMART MONEY FILTER */
/* ============================= */

export function computeSmartMoneyScore(scan) {

  let score = 50;

  // tendance propre
  if (scan.ema20 > scan.ema50) score += 10;
  else score -= 10;

  // momentum
  if (scan.momentum > 0) score += 8;
  else score -= 8;

  // RSI propre (pas extrême)
  if (scan.rsi14 > 45 && scan.rsi14 < 65) score += 10;
  else score -= 6;

  // volatilité contrôlée
  if (scan.atr14 < scan.current * 0.01) score += 6;
  else score -= 6;

  return clamp(score, 1, 99);
}

/* ============================= */
/* LIQUIDITY / SESSION FILTER */
/* ============================= */

export function computeSessionScore() {

  const now = new Date();

  const hour = Number(now.toLocaleString("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Europe/Paris"
  }));

  const london = hour >= 9 && hour < 18;
  const ny = hour >= 14 && hour < 23;
  const overlap = london && ny;

  if (overlap) return 90;
  if (london) return 75;
  if (ny) return 75;

  return 40; // off session
}

/* ============================= */
/* EXECUTION QUALITY */
/* ============================= */

export function computeExecutionScore(scan) {

  let score = 50;

  // RR
  if (scan.rr > 2) score += 15;
  else if (scan.rr > 1.5) score += 8;
  else score -= 10;

  // alignement scores
  if (scan.trendScore > 60 && scan.timingScore > 60) score += 10;
  else score -= 5;

  // ML + VBT
  if (scan.mlScore > 70) score += 8;
  if (scan.vectorbtScore > 70) score += 8;

  return clamp(score, 1, 99);
}

/* ============================= */
/* FINAL ULTRA SCORE */
/* ============================= */

export function computeUltraScore(scan) {

  const smartMoney = computeSmartMoneyScore(scan);
  const session = computeSessionScore();
  const execution = computeExecutionScore(scan);

  const ultraScore = Math.round(
    scan.finalScore * 0.4 +
    smartMoney * 0.2 +
    session * 0.2 +
    execution * 0.2
  );

  return {
    ultraScore,
    components: {
      base: scan.finalScore,
      smartMoney,
      session,
      execution
    },
    grade:
      ultraScore >= 85 ? "A+" :
      ultraScore >= 75 ? "A" :
      ultraScore >= 65 ? "B" :
      ultraScore >= 55 ? "C" :
      "D"
  };
}

/* ============================= */
/* TRADE FILTER (PRO MODE) */
/* ============================= */

export function shouldTakeTrade(scan) {

  const { ultraScore } = computeUltraScore(scan);

  if (ultraScore >= 75) {
    return {
      allowed: true,
      reason: "High probability trade"
    };
  }

  if (ultraScore >= 60) {
    return {
      allowed: true,
      reason: "Medium trade (reduced risk)"
    };
  }

  return {
    allowed: false,
    reason: "Filtered by AI engine"
  };
}

/* ============================= */
/* AUTO TAG */
/* ============================= */

export function tagTrade(scan) {

  if (scan.finalScore >= 85) return "SNIPER";
  if (scan.finalScore >= 75) return "A+ SETUP";
  if (scan.finalScore >= 65) return "SETUP";
  if (scan.finalScore >= 55) return "WEAK";

  return "TRASH";
      }
