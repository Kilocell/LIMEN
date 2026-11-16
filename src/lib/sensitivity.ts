// Sensitivity: moves each assumed constant by a fixed share and reports what changes.
import {
  ASSUMPTIONS,
  ASSUMPTION_KEYS,
  analyze,
  assumptionValue,
  linkTarget,
  withAssumptions,
  type AssumptionKey,
  type BenchConfig,
} from "./limen.ts";
import { rowAt, type Medium, type SensitivityVerdict } from "./assess.ts";

/** The share every constant is moved by, up and down. */
export const SENSITIVITY_SPREAD = 0.25;

/** What a solved board says, reduced to the few numbers a change can move. */
export type Snapshot = {
  /** The copper x16 trains. */
  copperUp: boolean;
  /** The optical eye meets its BER target and its loss mask at the board's trace length. */
  opticalUsable: boolean;
  opticalQ: number;
  copperPj: number;
  opticalPj: number;
  crossoverCm: number | null;
  /** Which usable medium costs less per bit, or null when neither is usable. */
  cheaper: Medium | null;
};

export type SensitivityRow = {
  key: AssumptionKey;
  label: string;
  unit: string;
  scale: number;
  /** The constant's value at this scale, in the unit shown. */
  value: number;
  snapshot: Snapshot;
  /** Qualitative changes against the base: a link going down, a crossover appearing, the cheaper medium swapping. */
  flips: string[];
  /** Quantitative changes large enough to notice. */
  shifts: string[];
  effect: "stable" | "shifts" | "flips";
};

export type SensitivityReport = {
  spread: number;
  base: Snapshot;
  rows: SensitivityRow[];
  verdict: SensitivityVerdict;
  /** Constants that changed something, the strongest first. */
  drivers: AssumptionKey[];
  /** Constants that changed nothing at this board. */
  inert: AssumptionKey[];
};

/** The solved numbers for one config, judged on the C-band eye at the board's trace length. */
export function snapshotOf(config: BenchConfig): Snapshot {
  const { report, frontier } = analyze(config);
  const lengthCm = report.chipset.traceCm;
  const cu = rowAt(frontier.rows, "copper", lengthCm);
  const op = rowAt(frontier.rows, "optical", lengthCm);
  const target = linkTarget(report.optical.gbitPerLane * 1e9);
  const copperPj = cu ? cu.energyPj : 0;
  const opticalPj = op ? op.energyPj : 0;
  const opticalUsable = !!op && op.ber <= target.ber && op.ilDb <= report.optical.budgetDb;
  const copperUp = report.link.up;
  let cheaper: Medium | null = null;
  if (copperUp && opticalUsable) cheaper = copperPj <= opticalPj ? "copper" : "optical";
  else if (copperUp) cheaper = "copper";
  else if (opticalUsable) cheaper = "optical";
  return { copperUp, opticalUsable, opticalQ: op ? op.q : 0, copperPj, opticalPj, crossoverCm: frontier.crossoverCm, cheaper };
}

/** Every scenario the sweep runs: each constant scaled down and up. */
export function sensitivityPlan(spread = SENSITIVITY_SPREAD): { key: AssumptionKey; scale: number }[] {
  return ASSUMPTION_KEYS.flatMap((key) => [
    { key, scale: 1 - spread },
    { key, scale: 1 + spread },
  ]);
}

export function sensitivityBase(config: BenchConfig): Snapshot {
  return withAssumptions({}, () => snapshotOf(config));
}

export function sensitivityRow(config: BenchConfig, base: Snapshot, key: AssumptionKey, scale: number): SensitivityRow {
  const snapshot = withAssumptions({ [key]: scale } as Partial<Record<AssumptionKey, number>>, () => snapshotOf(config));
  const info = ASSUMPTIONS[key];
  const flips: string[] = [];
  const shifts: string[] = [];
  if (base.copperUp && !snapshot.copperUp) flips.push("The copper x16 goes down.");
  if (base.opticalUsable && !snapshot.opticalUsable) flips.push("The optical eye closes.");
  if (!base.opticalUsable && snapshot.opticalUsable) flips.push("The optical eye opens.");
  if (base.crossoverCm === null && snapshot.crossoverCm !== null) flips.push(`Optical becomes cheaper from ${snapshot.crossoverCm} cm.`);
  if (base.crossoverCm !== null && snapshot.crossoverCm === null) flips.push("Optical no longer becomes cheaper within 60 cm.");
  if (base.cheaper !== null && snapshot.cheaper !== null && base.cheaper !== snapshot.cheaper) flips.push(`At the board's length ${snapshot.cheaper === "optical" ? "optical" : "copper"} becomes the cheaper medium.`);
  if (base.crossoverCm !== null && snapshot.crossoverCm !== null && Math.abs(snapshot.crossoverCm - base.crossoverCm) >= 4) {
    shifts.push(`The crossover moves from ${base.crossoverCm} to ${snapshot.crossoverCm} cm.`);
  }
  if (base.opticalQ > 0 && Math.abs(snapshot.opticalQ - base.opticalQ) >= 0.5) {
    shifts.push(`Optical Q moves from ${base.opticalQ.toFixed(1)} to ${snapshot.opticalQ.toFixed(1)}.`);
  }
  for (const [name, from, to] of [
    ["Optical", base.opticalPj, snapshot.opticalPj],
    ["Copper", base.copperPj, snapshot.copperPj],
  ] as const) {
    if (from > 0 && Math.abs(to - from) / from >= 0.1) shifts.push(`${name} energy moves from ${from.toFixed(1)} to ${to.toFixed(1)} pJ/bit.`);
  }
  return {
    key,
    label: info.label,
    unit: info.unit,
    scale,
    value: assumptionValue(key, scale),
    snapshot,
    flips,
    shifts,
    effect: flips.length > 0 ? "flips" : shifts.length > 0 ? "shifts" : "stable",
  };
}

/**
 * Judge the whole sweep.
 * Fragile: a constant 25 % off takes a working link down. Sensitive: it changes a conclusion
 * without taking anything down. Robust: nothing qualitative moves.
 */
export function summarizeSensitivity(base: Snapshot, rows: SensitivityRow[], spread = SENSITIVITY_SPREAD): SensitivityReport {
  const takesDown = (r: SensitivityRow) => (base.copperUp && !r.snapshot.copperUp) || (base.opticalUsable && !r.snapshot.opticalUsable);
  let verdict: SensitivityVerdict = "robust";
  if (rows.some((r) => r.effect === "flips")) verdict = "sensitive";
  if (rows.some(takesDown)) verdict = "fragile";

  const impact = (r: SensitivityRow) => {
    const q = base.opticalQ > 0 ? Math.abs(r.snapshot.opticalQ - base.opticalQ) / base.opticalQ : 0;
    const eo = base.opticalPj > 0 ? Math.abs(r.snapshot.opticalPj - base.opticalPj) / base.opticalPj : 0;
    const ec = base.copperPj > 0 ? Math.abs(r.snapshot.copperPj - base.copperPj) / base.copperPj : 0;
    const x = base.crossoverCm !== null && r.snapshot.crossoverCm !== null ? Math.abs(r.snapshot.crossoverCm - base.crossoverCm) / 20 : 0;
    return Math.max(q, eo, ec, x) + (r.effect === "flips" ? 10 : 0);
  };
  const best = new Map<AssumptionKey, number>();
  for (const r of rows) best.set(r.key, Math.max(best.get(r.key) ?? 0, impact(r)));
  const moved = new Set(rows.filter((r) => r.effect !== "stable").map((r) => r.key));
  const drivers = [...moved].sort((a, b) => (best.get(b) ?? 0) - (best.get(a) ?? 0));
  const inert = ASSUMPTION_KEYS.filter((key) => !moved.has(key));
  return { spread, base, rows, verdict, drivers, inert };
}

/** Run the whole sweep at once. About one second for a board. */
export function sensitivity(config: BenchConfig, spread = SENSITIVITY_SPREAD): SensitivityReport {
  const base = sensitivityBase(config);
  const rows = sensitivityPlan(spread).map(({ key, scale }) => sensitivityRow(config, base, key, scale));
  return summarizeSensitivity(base, rows, spread);
}

/**
 * The same sweep, yielding to the event loop between scenarios so a page stays responsive.
 * `onProgress` gets the share done, 0 to 1. Pass a signal to stop early.
 */
export async function sensitivityAsync(
  config: BenchConfig,
  onProgress?: (done: number) => void,
  signal?: { cancelled: boolean },
  spread = SENSITIVITY_SPREAD,
): Promise<SensitivityReport | null> {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const plan = sensitivityPlan(spread);
  const base = sensitivityBase(config);
  const rows: SensitivityRow[] = [];
  for (let i = 0; i < plan.length; i++) {
    if (signal?.cancelled) return null;
    await tick();
    rows.push(sensitivityRow(config, base, plan[i].key, plan[i].scale));
    onProgress?.((i + 1) / plan.length);
  }
  return summarizeSensitivity(base, rows, spread);
}
