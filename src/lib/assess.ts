// Connection status: turns a solved board into plain classes. Pure functions, no drawing.
import { linkTarget, type BenchReport, type LinkRow } from "./limen.ts";

export type Rating = "excellent" | "good" | "fair" | "poor" | "down";
export type Dimension = "stability" | "efficiency" | "overall";
export type Medium = "copper" | "optical";

const RANK: Record<Rating, number> = { down: 0, poor: 1, fair: 2, good: 3, excellent: 4 };

const LABELS: Record<Dimension, Record<Rating, string>> = {
  stability: { excellent: "Robust", good: "Stable", fair: "Thin margin", poor: "Unreliable", down: "Down" },
  efficiency: { excellent: "Frugal", good: "Efficient", fair: "Costly", poor: "Wasteful", down: "Down" },
  overall: { excellent: "Excellent", good: "Good", fair: "Fair", poor: "Poor", down: "Down" },
};

/** The word shown for a rating in one dimension, for example `Thin margin` for a fair stability. */
export function ratingLabel(dimension: Dimension, rating: Rating): string {
  return LABELS[dimension][rating];
}

export function worse(a: Rating, b: Rating): Rating {
  return RANK[a] <= RANK[b] ? a : b;
}

export function better(a: Rating, b: Rating): Rating {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Stability from how far the eye sits above its target, as a ratio of Q to the Q that reaches
 * the lane's BER target. 1.0 is exactly on target.
 */
export const STABILITY_RATIO = { excellent: 1.4, good: 1.2, fair: 1.05 } as const;

/** Share of the loss mask that is still free after the channel, as a fraction of the mask. */
export const LOSS_MARGIN_SHARE = { excellent: 0.4, good: 0.2 } as const;

/** Energy per bit limits [pJ/bit]. These are chosen for the model's range, not taken from a standard. */
export const EFFICIENCY_PJ = { excellent: 6, good: 10, fair: 16 } as const;

function byRatio(ratio: number): Rating {
  if (!(ratio > 0)) return "poor";
  if (ratio >= STABILITY_RATIO.excellent) return "excellent";
  if (ratio >= STABILITY_RATIO.good) return "good";
  if (ratio >= STABILITY_RATIO.fair) return "fair";
  return "poor";
}

/**
 * A channel inside its mask is never worse than thin on loss alone. The eye decides whether the
 * link is unreliable, so a channel that is close to its mask but still opens a wide eye reads as thin.
 */
function byLossMargin(share: number): Rating {
  if (share >= LOSS_MARGIN_SHARE.excellent) return "excellent";
  if (share >= LOSS_MARGIN_SHARE.good) return "good";
  return "fair";
}

function byEnergy(pj: number): Rating {
  if (pj <= EFFICIENCY_PJ.excellent) return "excellent";
  if (pj <= EFFICIENCY_PJ.good) return "good";
  if (pj <= EFFICIENCY_PJ.fair) return "fair";
  return "poor";
}

/** Stability counts for 65 % and efficiency for 35 % of a medium's overall class. */
function combine(stability: Rating, efficiency: Rating): Rating {
  if (stability === "down") return "down";
  if (stability === "poor") return "poor";
  const score = 0.65 * RANK[stability] + 0.35 * RANK[efficiency];
  if (score >= 3.5) return "excellent";
  if (score >= 2.75) return "good";
  if (score >= 1.75) return "fair";
  return "poor";
}

/** The row nearest to a length. The sweep runs 2 to 60 cm in 2 cm steps. */
export function rowAt(rows: readonly LinkRow[], medium: Medium, lengthCm: number): LinkRow | undefined {
  let best: LinkRow | undefined;
  let gap = Infinity;
  for (const row of rows) {
    if (row.medium !== medium) continue;
    const distance = Math.abs(row.lengthCm - lengthCm);
    if (distance < gap) {
      gap = distance;
      best = row;
    }
  }
  return best;
}

export type Finding = { level: "info" | "warn" | "alert"; text: string };

export type MediumAssessment = {
  medium: Medium;
  /** False when the medium is not part of this board, such as the optical fabric switched off. */
  present: boolean;
  stability: Rating;
  efficiency: Rating;
  overall: Rating;
  /** Q divided by the Q that reaches the BER target. Null when no eye is simulated. */
  qRatio: number | null;
  /** Loss mask minus the channel loss per segment [dB]. */
  lossMarginDb: number | null;
  pjPerBit: number | null;
  latencyPs: number | null;
};

export type SensitivityVerdict = "robust" | "sensitive" | "fragile";

export type Assessment = {
  lengthCm: number;
  copper: MediumAssessment;
  optical: MediumAssessment;
  /** The best class any working medium reaches. */
  overall: Rating;
  /** The working medium with the lower energy per bit, or null when none works. */
  cheaper: Medium | null;
  crossoverCm: number | null;
  qTarget: number;
  findings: Finding[];
};

function percent(ratio: number): string {
  return `${Math.round((ratio - 1) * 100)} %`;
}

/**
 * Classify one solved board.
 *
 * Copper uses the report's channel and the sweep's copper row at the board's trace length.
 * Optical uses the report's own eye, which is solved at the exact trace length.
 */
export function assess(
  report: BenchReport,
  frontier: { rows: readonly LinkRow[]; crossoverCm: number | null },
  sensitivityVerdict?: SensitivityVerdict,
): Assessment {
  const lengthCm = report.chipset.traceCm;
  const target = linkTarget(report.optical.gbitPerLane * 1e9);
  const findings: Finding[] = [];

  // Copper
  const cuRow = rowAt(frontier.rows, "copper", lengthCm);
  const segments = report.link.retimers + 1;
  const perSegment = report.link.ilDb / segments;
  const lossMarginDb = report.link.budgetDb - perSegment;
  const cuRatio = cuRow ? cuRow.q / target.q : null;
  let cuStability: Rating = "down";
  if (report.link.up) {
    cuStability = worse(cuRatio === null ? "good" : byRatio(cuRatio), byLossMargin(lossMarginDb / report.link.budgetDb));
    if (report.link.trained !== report.link.attempted) cuStability = worse(cuStability, "fair");
  }
  const cuPj = cuRow ? cuRow.energyPj : null;
  const cuEfficiency: Rating = cuPj === null ? "down" : byEnergy(cuPj);
  const copper: MediumAssessment = {
    medium: "copper",
    present: true,
    stability: cuStability,
    efficiency: report.link.up ? cuEfficiency : "down",
    overall: combine(cuStability, cuEfficiency),
    qRatio: cuRatio,
    lossMarginDb,
    pjPerBit: cuPj,
    latencyPs: cuRow ? cuRow.latencyPs : null,
  };

  // Optical
  const o = report.optical;
  const cEye = o.enabled && o.band === "c1550";
  const opRatio = cEye ? o.q / target.q : null;
  let opStability: Rating = "down";
  if (o.enabled && o.up) {
    const lossShare = (o.budgetDb - o.ilDb) / o.budgetDb;
    opStability = opRatio === null ? byLossMargin(lossShare) : worse(byRatio(opRatio), byLossMargin(lossShare));
    if (o.modulator.laserLimited) opStability = worse(opStability, "fair");
  }
  const opEfficiency: Rating = o.enabled ? byEnergy(o.energyPj) : "down";
  const optical: MediumAssessment = {
    medium: "optical",
    present: o.enabled,
    stability: opStability,
    efficiency: opEfficiency,
    overall: o.enabled ? combine(opStability, opEfficiency) : "down",
    qRatio: opRatio,
    lossMarginDb: o.enabled ? o.budgetDb - o.ilDb : null,
    pjPerBit: o.enabled ? o.energyPj : null,
    latencyPs: o.enabled ? o.latencyPs : null,
  };

  const copperWorks = report.link.up && cuPj !== null;
  const opticalWorks = o.enabled && o.up;
  let cheaper: Medium | null = null;
  if (copperWorks && opticalWorks) cheaper = (cuPj as number) <= o.energyPj ? "copper" : "optical";
  else if (copperWorks) cheaper = "copper";
  else if (opticalWorks) cheaper = "optical";

  const overall = optical.present ? better(copper.overall, optical.overall) : copper.overall;

  // Findings, most urgent first.
  if (!report.link.up) findings.push({ level: "alert", text: report.link.reason });
  if (o.enabled && !o.up) findings.push({ level: "alert", text: o.reason });
  if (report.link.up && report.link.trained !== report.link.attempted) {
    findings.push({ level: "warn", text: `The copper x16 trained at Gen ${report.link.trained}, not the Gen ${report.link.attempted} requested.` });
  }
  if (report.link.up && report.link.retimers > 0) {
    findings.push({
      level: "warn",
      text: `The copper channel is ${report.link.ilDb.toFixed(1)} dB against a ${report.link.budgetDb} dB mask and needs ${report.link.retimers} retimer${report.link.retimers === 1 ? "" : "s"}.`,
    });
  }
  if (opticalWorks && opRatio !== null && opStability === "fair") {
    findings.push({
      level: "warn",
      text: `The optical eye is close to its limit: Q ${o.q.toFixed(1)} against ${target.q.toFixed(1)} needed (${percent(opRatio)} above).`,
    });
  }
  if (opticalWorks && o.modulator.laserLimited) {
    findings.push({ level: "warn", text: "The laser is at its output limit, so the optical power falls short of the target launch." });
  }
  if (o.enabled && o.band === "o1310") {
    findings.push({ level: "info", text: "O-band: the rings are made for 1550 nm, so only the loss budget is checked and no eye is simulated." });
  }
  if (report.cpu.runaway || report.gpu.runaway) {
    findings.push({ level: "alert", text: "A die is in thermal runaway. The electrical numbers above are not a steady state." });
  } else if (report.cpu.throttled || report.gpu.throttled) {
    findings.push({ level: "warn", text: "A die is throttling to stay under its temperature limit." });
  }
  if (copperWorks && opticalWorks && cuPj !== null) {
    const ratio = o.energyPj / cuPj;
    findings.push({
      level: "info",
      text: `At ${lengthCm} cm optical costs ${o.energyPj.toFixed(1)} pJ/bit and copper ${cuPj.toFixed(1)} pJ/bit (optical is ${ratio >= 1 ? `${ratio.toFixed(2)}× the energy` : `${(1 / ratio).toFixed(2)}× less energy`}).`,
    });
  }
  if (o.enabled && cEye) {
    findings.push({
      level: "info",
      text: frontier.crossoverCm === null ? "Optical never becomes the cheaper choice within 60 cm." : `Optical becomes the cheaper choice from ${frontier.crossoverCm} cm.`,
    });
  }
  if (sensitivityVerdict === "fragile") {
    findings.push({ level: "warn", text: "A 25 % change in an assumed constant can bring a link down. Treat this result as provisional." });
  } else if (sensitivityVerdict === "sensitive") {
    findings.push({ level: "info", text: "A 25 % change in an assumed constant can change a conclusion, such as where optical becomes cheaper." });
  } else if (sensitivityVerdict === "robust") {
    findings.push({ level: "info", text: "The conclusions hold when each assumed constant moves by 25 %." });
  }

  return { lengthCm, copper, optical, overall, cheaper, crossoverCm: frontier.crossoverCm, qTarget: target.q, findings };
}
