// Tests for the status classes, the sensitivity sweep and the report export. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, analyze, evaluate, withAssumptions, withConfig, ASSUMPTION_KEYS, type BenchConfig } from "../src/lib/limen.ts";
import { assess, ratingLabel, rowAt, type Rating } from "../src/lib/assess.ts";
import { sensitivity, sensitivityAsync, sensitivityPlan, snapshotOf, SENSITIVITY_SPREAD } from "../src/lib/sensitivity.ts";
import { frontierCsv, reportFileName, reportJson, reportMarkdown, REPORT_SCHEMA, type ReportInput } from "../src/lib/report.ts";

const stable = (o: unknown): string =>
  JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

const preset = (id: string): BenchConfig => PRESETS.find((p) => p.id === id)!.config;

function inputFor(config: BenchConfig, withSensitivity = false): ReportInput {
  const { report, frontier } = analyze(config);
  const s = withSensitivity ? sensitivity(config) : null;
  return { generatedAt: "2026-11-15T12:00:00.000Z", presetLabel: "Test board", report, frontier, assessment: assess(report, frontier, s?.verdict), sensitivity: s };
}

test("withAssumptions changes the model inside the call and restores it afterwards, even on a throw", () => {
  const cfg = preset("ddr5");
  const before = stable(evaluate(cfg));
  const dim = withAssumptions({ launchW: 0.5 }, () => evaluate(cfg).optical.q);
  const bright = withAssumptions({ launchW: 1.5 }, () => evaluate(cfg).optical.q);
  assert.ok(bright > dim, `more launch power should open the eye (${dim} vs ${bright})`);
  assert.equal(stable(evaluate(cfg)), before, "scale 1 must be back after the call");
  assert.throws(() => withAssumptions({ launchW: 0.5 }, () => { throw new Error("boom"); }), /boom/);
  assert.equal(stable(evaluate(cfg)), before, "scale 1 must be back after a throw");
});

test("withAssumptions clamps and ignores bad factors", () => {
  const cfg = preset("ddr3");
  const base = stable(evaluate(cfg));
  assert.equal(withAssumptions({ launchW: Number.NaN, rxBwFrac: Infinity }, () => stable(evaluate(cfg))), base);
  const tiny = withAssumptions({ launchW: -5 }, () => evaluate(cfg).optical.q);
  const floor = withAssumptions({ launchW: 0.1 }, () => evaluate(cfg).optical.q);
  assert.equal(tiny, floor, "a factor below 0.1 is held at 0.1");
});

test("every assumed constant is wired into the model", () => {
  // Each constant must change at least one number on some preset, or it is dead code.
  const touched = new Set<string>();
  for (const key of ASSUMPTION_KEYS) {
    for (const id of ["ddr2", "ddr5", "gen7"]) {
      const cfg = preset(id);
      const base = withAssumptions({}, () => snapshotOf(cfg));
      for (const scale of [0.5, 2]) {
        const moved = withAssumptions({ [key]: scale }, () => snapshotOf(cfg));
        if (stable(moved) !== stable(base)) touched.add(key);
      }
    }
  }
  // The copper noise and crosstalk floors sit far below copper's eye on these boards, so they may stay inert here.
  const inertOk = new Set(["rxNoise", "copperXtalk", "laserMaxW"]);
  for (const key of ASSUMPTION_KEYS) if (!inertOk.has(key)) assert.ok(touched.has(key), `${key} changes nothing`);
});

test("the copper noise and crosstalk floors do move copper when pushed hard", () => {
  const cfg = withConfig(preset("gen7"), { requestedGen: "5.0" });
  const { frontier } = analyze(cfg);
  const q = (rows: typeof frontier.rows) => rowAt(rows, "copper", 60)!.q;
  const base = q(frontier.rows);
  const noisy = withAssumptions({ rxNoise: 3 }, () => q(analyze(cfg).frontier.rows));
  const leaky = withAssumptions({ copperXtalk: 0.3 }, () => q(analyze(cfg).frontier.rows));
  assert.ok(noisy < base, "more receiver noise lowers copper Q");
  assert.ok(leaky < base, "worse crosstalk lowers copper Q");
});

// Regression snapshot. If a model change moves these on purpose, update them and say why in the commit.
test("status classes and sensitivity verdicts per preset", () => {
  const expected: Record<string, { overall: Rating; copper: [Rating, Rating]; optical: [Rating, Rating]; verdict: string; firstDriver: string }> = {
    ddr2: { overall: "good", copper: ["excellent", "poor"], optical: ["fair", "poor"], verdict: "sensitive", firstDriver: "launchW" },
    ddr3: { overall: "good", copper: ["excellent", "fair"], optical: ["good", "fair"], verdict: "robust", firstDriver: "rxBwFrac" },
    ddr4: { overall: "good", copper: ["excellent", "fair"], optical: ["good", "fair"], verdict: "robust", firstDriver: "rxBwFrac" },
    ddr5: { overall: "excellent", copper: ["excellent", "good"], optical: ["good", "fair"], verdict: "sensitive", firstDriver: "opticalFixtureShare" },
    arrow: { overall: "excellent", copper: ["excellent", "good"], optical: ["good", "fair"], verdict: "sensitive", firstDriver: "opticalFixtureShare" },
    storm: { overall: "excellent", copper: ["excellent", "good"], optical: ["fair", "fair"], verdict: "fragile", firstDriver: "launchW" },
    gen7: { overall: "excellent", copper: ["excellent", "good"], optical: ["fair", "fair"], verdict: "fragile", firstDriver: "launchW" },
  };
  for (const p of PRESETS) {
    const { report, frontier } = analyze(p.config);
    const s = sensitivity(p.config);
    const a = assess(report, frontier, s.verdict);
    const e = expected[p.id];
    assert.equal(a.overall, e.overall, `${p.id} overall`);
    assert.deepEqual([a.copper.stability, a.copper.efficiency], e.copper, `${p.id} copper`);
    assert.deepEqual([a.optical.stability, a.optical.efficiency], e.optical, `${p.id} optical`);
    assert.equal(s.verdict, e.verdict, `${p.id} verdict`);
    assert.equal(s.drivers[0], e.firstDriver, `${p.id} first driver`);
    // A preset is a clean machine, so no medium may read down or unreliable on it.
    for (const m of [a.copper, a.optical]) assert.ok(m.stability !== "down" && m.stability !== "poor", `${p.id} ${m.medium} is ${m.stability}`);
  }
});

test("sensitivity plan, rows and the async run agree", async () => {
  const cfg = preset("ddr3");
  const plan = sensitivityPlan();
  assert.equal(plan.length, ASSUMPTION_KEYS.length * 2);
  assert.ok(plan.every((x) => Math.abs(Math.abs(x.scale - 1) - SENSITIVITY_SPREAD) < 1e-12));
  const sync = sensitivity(cfg);
  assert.equal(sync.rows.length, plan.length);
  assert.equal(stable(sync.base), stable(snapshotOf(cfg)), "the base snapshot is the untouched model");
  const seen: number[] = [];
  const asyncResult = await sensitivityAsync(cfg, (done) => seen.push(done));
  assert.equal(stable(asyncResult), stable(sync));
  assert.equal(seen[seen.length - 1], 1);
  assert.ok(seen.every((v, i) => i === 0 || v > seen[i - 1]), "progress only goes forward");
  // A cancelled run returns nothing, and the model is back at scale 1.
  const signal = { cancelled: false };
  const stopped = await sensitivityAsync(cfg, () => { signal.cancelled = true; }, signal);
  assert.equal(stopped, null);
  assert.equal(stable(snapshotOf(cfg)), stable(sync.base));
});

test("a verdict of fragile means some constant takes a working link down", () => {
  const s = sensitivity(preset("storm"));
  assert.equal(s.verdict, "fragile");
  assert.ok(s.rows.some((r) => s.base.opticalUsable && !r.snapshot.opticalUsable), "a scenario closes the optical eye");
  assert.ok(s.rows.every((r) => r.effect === "flips" || r.flips.length === 0));
});

test("rating thresholds on a synthetic report", () => {
  const cfg = preset("ddr5");
  const { report, frontier } = analyze(cfg);
  const target = assess(report, frontier).qTarget;
  // A short, low-loss channel so the eye alone decides the class.
  const withQ = (ratio: number) => assess({ ...report, optical: { ...report.optical, ilDb: 4, q: target * ratio } }, frontier).optical.stability;
  assert.equal(withQ(1.6), "excellent");
  assert.equal(withQ(1.3), "good");
  assert.equal(withQ(1.1), "fair");
  assert.equal(withQ(1.0), "poor");
  const down = assess({ ...report, link: { ...report.link, up: false } }, frontier);
  assert.equal(down.copper.stability, "down");
  assert.equal(down.copper.overall, "down");
  assert.ok(down.findings.some((f) => f.level === "alert"));
  const off = assess({ ...report, optical: { ...report.optical, enabled: false, up: false } }, frontier);
  assert.equal(off.optical.present, false);
  assert.equal(off.overall, off.copper.overall, "with the optical fabric off the board is judged on its copper");
  const limited = assess({ ...report, optical: { ...report.optical, modulator: { ...report.optical.modulator, laserLimited: true } } }, frontier);
  assert.ok(["fair", "poor"].includes(limited.optical.stability), "a laser at its limit caps stability");
  const fellBack = assess({ ...report, link: { ...report.link, trained: "3.0" } }, frontier);
  assert.ok(["fair", "poor"].includes(fellBack.copper.stability), "training below the request caps stability");
  assert.ok(fellBack.findings.some((f) => /trained at Gen 3.0/.test(f.text)));
});

test("labels read well in every dimension", () => {
  const ratings: Rating[] = ["excellent", "good", "fair", "poor", "down"];
  for (const dim of ["stability", "efficiency", "overall"] as const) {
    const labels = ratings.map((r) => ratingLabel(dim, r));
    assert.equal(new Set(labels).size, ratings.length, `${dim} labels are distinct`);
    assert.ok(labels.every((l) => l.length > 0));
  }
});

test("a thin optical margin and a retimer are called out in the findings", () => {
  const a = inputFor(preset("gen7")).assessment;
  assert.ok(a.findings.some((f) => f.level === "warn" && /close to its limit/.test(f.text)));
  assert.ok(a.findings.some((f) => f.level === "warn" && /retimer/.test(f.text)));
});

test("the Markdown report is complete, finite and repeatable", () => {
  for (const id of ["ddr2", "gen7"]) {
    const input = inputFor(preset(id), true);
    const md = reportMarkdown(input);
    assert.equal(md, reportMarkdown(input), "same input, same text");
    for (const must of ["# LIMEN report: Test board", "not a measurement instrument", "## Status", "## Link", "## Sensitivity", "## Assumed constants", "```json"]) {
      assert.ok(md.includes(must), `${id} report lacks ${must}`);
    }
    assert.ok(!/NaN|undefined|Infinity/.test(md), `${id} report has a bad value`);
    // Every table keeps its column count, so a stray pipe cannot break one.
    let cols = 0;
    for (const line of md.split("\n")) {
      if (!line.startsWith("|")) { cols = 0; continue; }
      const n = line.split(" | ").length;
      if (cols === 0) cols = n;
      assert.equal(n, cols, `${id}: table row has ${n} cells, expected ${cols}: ${line.slice(0, 60)}`);
    }
  }
  assert.ok(!reportMarkdown(inputFor(preset("ddr5"), false)).includes("## Sensitivity"), "no sensitivity section without a run");
});

test("the JSON report parses and carries the schema, the config and the sweep", () => {
  const input = inputFor(preset("ddr5"), true);
  const j = JSON.parse(reportJson(input));
  assert.equal(j.schema, REPORT_SCHEMA);
  assert.equal(j.preset, "Test board");
  assert.equal(j.status.overall, input.assessment.overall);
  assert.equal(j.config.chipsetId, input.report.config.chipsetId);
  assert.equal(j.sweep.length, 60);
  assert.equal(j.sensitivity.rows.length, ASSUMPTION_KEYS.length * 2);
  assert.deepEqual(Object.keys(j.assumptions).sort(), [...ASSUMPTION_KEYS].sort());
  assert.equal(JSON.parse(reportJson(inputFor(preset("ddr5"), false))).sensitivity, null);
});

test("the CSV has one row per medium and length, and a safe file name", () => {
  const input = inputFor(preset("ddr4"));
  const lines = frontierCsv(input.frontier.rows).trim().split("\n");
  assert.equal(lines.length, 61);
  assert.equal(lines[0], "medium,length_cm,q,ber,insertion_loss_db,energy_pj_per_bit,latency_ps");
  assert.ok(lines.slice(1).every((l) => l.split(",").length === 7 && !/NaN|Infinity/.test(l)));
  assert.equal(reportFileName({ ...input, presetLabel: "DDR4 · 2022" }, "md"), "limen-ddr4-2022-2026-11-15.md");
  assert.equal(reportFileName({ ...input, presetLabel: null }, "csv"), "limen-custom-2026-11-15-sweep.csv");
  assert.equal(reportFileName({ ...input, presetLabel: "../../x" }, "json"), "limen-x-2026-11-15.json");
});

test("a board with the optical fabric off still reports and exports", () => {
  const cfg = withConfig(preset("ddr5"), { optical: { enabled: false } });
  const input = inputFor(cfg, false);
  assert.equal(input.assessment.optical.present, false);
  const md = reportMarkdown(input);
  assert.ok(!/NaN|undefined/.test(md));
  assert.ok(JSON.parse(reportJson(input)).status.optical.present === false);
});

test("a stray pipe or line break in a label cannot break a Markdown table", () => {
  const base = inputFor(preset("ddr4"));
  const input: ReportInput = { ...base, report: { ...base.report, chipset: { ...base.report.chipset, label: "Odd | name\nsecond line" } } };
  const md = reportMarkdown(input);
  assert.ok(md.includes("Odd / name second line"), "pipe becomes a slash and the break a space");
  const boardRow = md.split("\n").find((l) => l.startsWith("| Chipset"))!;
  assert.equal(boardRow.split(" | ").length, 2, "the row still has exactly two cells");
});
