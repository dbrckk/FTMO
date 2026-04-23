import { clamp } from "./utils.js";

export function computeSessionScore() {
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

  if (overlap) return 95;
  if (london) return 78;
  if (newYork) return 76;

  return 42;
}

export function computeSmartMoneyScore(scan) {
  let score = 50;

  if (scan.ema20 > scan.ema50) score += 12;
  else score -= 12;

  if (scan.momentum > 0) score += 8;
  else score -= 8;

  if (scan.rsi14 > 45 && scan.rsi14 < 65) score += 10;
  else score -= 6;

  if (scan.rr >= 2) score += 8;
  else if (scan.rr < 1.4) score -= 8;

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

  return clamp(score, 1, 99);
}

export function computeUltraScore(scan) {
  const smartMoney = computeSmartMoneyScore(scan);
  const session = computeSessionScore();
  const execution = computeExecutionScore(scan);

  const ultraScore = Math.round(
    (scan.finalScore || 0) * 0.40 +
    smartMoney * 0.20 +
    session * 0.15 +
    execution * 0.25
  );

  return {
    ultraScore: clamp(ultraScore, 1, 99),
    smartMoney,
    session,
    execution,
    grade:
      ultraScore >= 90 ? "A+" :
      ultraScore >= 82 ? "A" :
      ultraScore >= 72 ? "B" :
      ultraScore >= 62 ? "C" :
      "D"
  };
}

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
