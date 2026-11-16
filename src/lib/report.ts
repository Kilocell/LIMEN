// Report export: a readable Markdown file, a JSON file for other tools, and a CSV of the length sweep.
import {
  ASSUMPTIONS,
  ASSUMPTION_KEYS,
  CPU_ARCH,
  GPU_ARCH,
  type BenchReport,
  type LinkRow,
} from "./limen.ts";
import { ratingLabel, type Assessment, type MediumAssessment } from "./assess.ts";
import type { SensitivityReport } from "./sensitivity.ts";

export type ReportInput = {
  /** ISO timestamp for the header. The caller supplies it so the output is a pure function of its input. */
  generatedAt: string;
  /** The preset's label when the board is untouched, otherwise null. */
  presetLabel: string | null;
  report: BenchReport;
  frontier: { rows: readonly LinkRow[]; crossoverCm: number | null };
  assessment: Assessment;
  sensitivity: SensitivityReport | null;
};

export const REPORT_SCHEMA = "limen-report/1";

export const REPORT_DISCLAIMER =
  "LIMEN is a simulator, not a measurement instrument. Its numbers are educated assumptions until you replace them with your own data.";

function num(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function sci(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value === 0 ? "0" : value.toExponential(1);
}

function gb(bytes: number): string {
  return Number.isFinite(bytes) ? (bytes / 1e9).toFixed(1) : "n/a";
}

/** A table cell must not contain a pipe or a line break. */
function cell(text: string): string {
  return text.replace(/\|/g, "/").replace(/\s*\n\s*/g, " ");
}

function table(head: string[], rows: string[][]): string {
  const line = (cols: string[]) => `| ${cols.map(cell).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

function mediumRow(m: MediumAssessment, name: string): string[] {
  if (!m.present) return [name, "off", "", "", "", "", ""];
  return [
    name,
    ratingLabel("overall", m.overall),
    ratingLabel("stability", m.stability),
    ratingLabel("efficiency", m.efficiency),
    m.qRatio === null ? "n/a" : `${num(m.qRatio, 2)}×`,
    num(m.pjPerBit),
    m.latencyPs === null ? "n/a" : num(m.latencyPs / 1000, 2),
  ];
}

function fileStem(input: ReportInput): string {
  const name = (input.presetLabel ?? "custom").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
  const day = input.generatedAt.slice(0, 10).replace(/[^0-9-]/g, "");
  return `limen-${name}-${day || "report"}`;
}

/** The file name for an export, for example `limen-ddr5-2025-2026-11-15.md`. */
export function reportFileName(input: ReportInput, extension: "md" | "json" | "csv"): string {
  return `${fileStem(input)}${extension === "csv" ? "-sweep" : ""}.${extension}`;
}

export function frontierCsv(rows: readonly LinkRow[]): string {
  const head = "medium,length_cm,q,ber,insertion_loss_db,energy_pj_per_bit,latency_ps";
  const body = rows.map((r) =>
    [r.medium, r.lengthCm, r.q, r.ber, r.ilDb, r.energyPj, r.latencyPs].map((v) => (typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v)).join(","),
  );
  return [head, ...body].join("\n") + "\n";
}

export function reportMarkdown(input: ReportInput): string {
  const { report, assessment: a, sensitivity: s } = input;
  const c = report.config;
  const out: string[] = [];
  out.push(`# LIMEN report${input.presetLabel ? `: ${input.presetLabel}` : " (custom board)"}`);
  out.push("");
  out.push(`Generated ${input.generatedAt}. ${REPORT_DISCLAIMER}`);
  out.push("");
  out.push("## Status");
  out.push("");
  out.push(`**Overall: ${ratingLabel("overall", a.overall)}.** ${a.cheaper === null ? "No medium works." : `The cheaper working medium at ${a.lengthCm} cm is ${a.cheaper}.`}`);
  out.push("");
  out.push(table(["Medium", "Overall", "Stability", "Efficiency", "Q vs target", "pJ/bit", "Latency (ns)"], [mediumRow(a.copper, "Copper x16"), mediumRow(a.optical, "Optical")]));
  out.push("");
  out.push(`Stability compares the eye with the Q that reaches the lane's BER target (Q ${num(a.qTarget, 2)}). Efficiency is energy per bit. Both are classes chosen for this model, not standards.`);
  if (a.findings.length > 0) {
    out.push("");
    out.push("## Findings");
    out.push("");
    for (const f of a.findings) out.push(`- ${f.level === "alert" ? "**Alert.** " : f.level === "warn" ? "**Warning.** " : ""}${f.text}`);
  }
  out.push("");
  out.push("## Board");
  out.push("");
  out.push(
    table(
      ["Part", "Setting"],
      [
        ["Chipset", `${report.chipset.label} (${report.chipset.family}), ${report.chipset.traceCm} cm ${report.chipset.laminate === "fr4" ? "FR-4" : "Megtron"} trace`],
        ["CPU", `${CPU_ARCH[c.cpu.arch].label}, ${c.cpu.cores} cores, ${c.cpu.threads} threads, ${num(report.cpu.deliveredGhz, 2)} GHz delivered`],
        ["GPU", `${GPU_ARCH[c.gpu.arch].label}, ${c.gpu.shaders} shaders, ${num(report.gpu.deliveredGhz, 2)} GHz delivered`],
        ["DRAM", `${c.dram.kind.toUpperCase()}, ${c.dram.gb} GB, ${gb(report.dram.bytesPerSec)} GB/s`],
        ["VRAM", `${c.vram.kind.toUpperCase()}, ${c.vram.gb} GB, ${gb(report.vram.bytesPerSec)} GB/s`],
        ["Room", `${c.ambientC} °C`],
      ],
    ),
  );
  out.push("");
  out.push("## Link");
  out.push("");
  out.push(
    table(
      ["", "Copper x16", "Optical"],
      [
        ["State", report.link.up ? `up, Gen ${report.link.trained}` : "down", report.optical.enabled ? (report.optical.up ? "open" : "closed") : "off"],
        ["Payload each way (GB/s)", gb(report.link.up ? report.link.bytesPerSecEachWay : 0), gb(report.optical.enabled && report.optical.up ? report.optical.bytesPerSec : 0)],
        ["Insertion loss (dB)", `${num(report.link.ilDb)} of ${report.link.budgetDb}${report.link.retimers > 0 ? `, ${report.link.retimers} retimer${report.link.retimers === 1 ? "" : "s"}` : ""}`, report.optical.enabled ? `${num(report.optical.ilDb)} of ${report.optical.budgetDb}` : "off"],
        ["Q", a.copper.qRatio === null ? "n/a" : num(a.copper.qRatio * a.qTarget), report.optical.enabled && report.optical.band === "c1550" ? num(report.optical.q) : "n/a"],
        ["BER", "see sweep", report.optical.enabled && report.optical.band === "c1550" ? sci(report.optical.ber) : "n/a"],
        ["Energy (pJ/bit)", num(a.copper.pjPerBit), report.optical.enabled ? num(report.optical.energyPj) : "off"],
        ["Optical lanes", "", report.optical.enabled ? `${report.optical.lanes} × ${report.optical.format.toUpperCase()} ${num(report.optical.gbitPerLane, 1)} Gbit/s` : "off"],
        ["Modulator", "", report.optical.enabled ? `${report.optical.modulator.label}, ${num(report.optical.modulator.lengthMm)} mm, ${num(report.optical.modulator.swingV)} Vpp` : "off"],
      ],
    ),
  );
  out.push("");
  out.push(a.crossoverCm === null ? "Optical never becomes the cheaper medium within 60 cm." : `Optical becomes the cheaper medium from ${a.crossoverCm} cm.`);
  out.push("");
  out.push("## Power and heat");
  out.push("");
  out.push(
    table(
      ["Item", "Value"],
      [
        ["Electrical power", `${num(report.electricalW, 0)} W`],
        ["Heat to the room", `${num(report.heatW, 0)} W`],
        ["CPU", `${num(report.cpu.watts, 0)} W, junction ${num(report.cpu.junctionC)} °C of ${report.cpu.tMaxC} °C${report.cpu.throttled ? ", throttling" : ""}`],
        ["GPU", `${num(report.gpu.asicW + report.vram.watts, 0)} W board, junction ${num(report.gpu.junctionC)} °C of ${report.gpu.tMaxC} °C${report.gpu.throttled ? ", throttling" : ""}`],
        ["Optical", `${num(report.optical.watts, 1)} W`],
      ],
    ),
  );
  if (s) {
    out.push("");
    out.push("## Sensitivity");
    out.push("");
    out.push(
      `Verdict: **${s.verdict}**. Each assumed constant was moved by ${Math.round(s.spread * 100)} % down and up, one at a time.` +
        (s.drivers.length > 0 ? ` Constants that changed something: ${s.drivers.map((k) => ASSUMPTIONS[k].label).join(", ")}.` : "") +
        (s.inert.length > 0 ? ` Constants that changed nothing on this board: ${s.inert.map((k) => ASSUMPTIONS[k].label).join(", ")}.` : ""),
    );
    out.push("");
    const changed = s.rows.filter((r) => r.effect !== "stable");
    if (changed.length > 0) {
      out.push(
        table(
          ["Constant", "Value", "Effect"],
          changed.map((r) => [r.label, `${num(r.value, 3)} ${r.unit}`.trim(), [...r.flips, ...r.shifts].join(" ")]),
        ),
      );
    } else out.push("No constant changed a result.");
  }
  out.push("");
  out.push("## Assumed constants");
  out.push("");
  out.push(table(["Constant", "Value", "What it does"], ASSUMPTION_KEYS.map((k) => [ASSUMPTIONS[k].label, `${num(ASSUMPTIONS[k].value, 3)} ${ASSUMPTIONS[k].unit}`.trim(), ASSUMPTIONS[k].note])));
  out.push("");
  out.push("## Configuration");
  out.push("");
  out.push("The board settings, so the run can be reproduced.");
  out.push("");
  out.push("```json");
  out.push(JSON.stringify(c, null, 2));
  out.push("```");
  out.push("");
  return out.join("\n");
}

export function reportJson(input: ReportInput): string {
  const { report, assessment: a, sensitivity: s } = input;
  const finite = (v: number | null) => (v === null || !Number.isFinite(v) ? null : v);
  const medium = (m: MediumAssessment) => ({
    present: m.present,
    overall: m.overall,
    stability: m.stability,
    efficiency: m.efficiency,
    qRatio: finite(m.qRatio),
    lossMarginDb: finite(m.lossMarginDb),
    pjPerBit: finite(m.pjPerBit),
    latencyPs: finite(m.latencyPs),
  });
  const payload = {
    schema: REPORT_SCHEMA,
    generatedAt: input.generatedAt,
    preset: input.presetLabel,
    disclaimer: REPORT_DISCLAIMER,
    config: report.config,
    status: {
      overall: a.overall,
      cheaper: a.cheaper,
      lengthCm: a.lengthCm,
      crossoverCm: a.crossoverCm,
      qTarget: a.qTarget,
      copper: medium(a.copper),
      optical: medium(a.optical),
      findings: a.findings,
    },
    link: {
      copper: {
        up: report.link.up,
        trained: report.link.trained,
        attempted: report.link.attempted,
        ilDb: report.link.ilDb,
        budgetDb: report.link.budgetDb,
        retimers: report.link.retimers,
        bytesPerSecEachWay: report.link.bytesPerSecEachWay,
      },
      optical: {
        enabled: report.optical.enabled,
        up: report.optical.up,
        band: report.optical.band,
        lanes: report.optical.lanes,
        gbitPerLane: report.optical.gbitPerLane,
        format: report.optical.format,
        ilDb: report.optical.ilDb,
        budgetDb: report.optical.budgetDb,
        q: report.optical.q,
        ber: report.optical.ber,
        energyPj: report.optical.energyPj,
        latencyPs: report.optical.latencyPs,
        bytesPerSec: report.optical.bytesPerSec,
        watts: report.optical.watts,
        modulator: report.optical.modulator,
      },
    },
    power: {
      electricalW: report.electricalW,
      heatW: report.heatW,
      cpu: { watts: report.cpu.watts, junctionC: report.cpu.junctionC, throttled: report.cpu.throttled, runaway: report.cpu.runaway },
      gpu: { asicW: report.gpu.asicW, vramW: report.vram.watts, junctionC: report.gpu.junctionC, throttled: report.gpu.throttled, runaway: report.gpu.runaway },
    },
    sweep: input.frontier.rows,
    assumptions: Object.fromEntries(ASSUMPTION_KEYS.map((k) => [k, { value: ASSUMPTIONS[k].value, unit: ASSUMPTIONS[k].unit }])),
    sensitivity: s
      ? {
          spread: s.spread,
          verdict: s.verdict,
          drivers: s.drivers,
          inert: s.inert,
          base: s.base,
          rows: s.rows.map((r) => ({ key: r.key, scale: r.scale, value: r.value, effect: r.effect, flips: r.flips, shifts: r.shifts, snapshot: r.snapshot })),
        }
      : null,
  };
  return JSON.stringify(payload, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v), 2) + "\n";
}
