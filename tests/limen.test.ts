// Model tests. Run with `npm test` (Node's built-in runner, no extra dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRESETS, DEFAULT_PRESET, evaluate, sanitize, withConfig, fitMemory, ratedLink, solveFrontier,
  modulatorSpec, MODULATORS, MODULATOR_IDS, MODULATOR_LENGTH_MM, MODULATOR_SWING_V,
  CHIPSET_ORDER, CPU_ORDER, GPU_ORDER, PCIE_GENS, DRAM_KINDS, VRAM_KINDS, PRECISIONS, COOLER_IDS, GDDR_BUS_BITS,
  type BenchConfig, type ModulatorId,
} from "../src/lib/limen.ts";

/** Every finite-number rule in one place: report numbers must never be NaN or Infinity. */
function nonFinite(value: unknown, path = ""): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [`${path}=${value}`];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => nonFinite(v, `${path}.${k}`));
  }
  return [];
}

const stable = (o: unknown): string =>
  JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

/** Raw copper-versus-optical sweep for one preset and modulator at its default length and swing. */
function sweep(config: BenchConfig, id: ModulatorId) {
  const cfg = withConfig(config, { optical: { modulator: id, modLengthMm: MODULATORS[id].lengthMm, modSwingV: MODULATORS[id].swingV } });
  const r = evaluate(cfg);
  const rises = { wg: r.optical.riseWgK, ring: r.optical.riseRingK, hot: r.optical.riseRingK, cold: 1, tiaC: cfg.ambientC + r.optical.riseWgK };
  const frontier = solveFrontier(rises, r.chipset.laminate, cfg.optical.gbitPerLane * 1e9, true, modulatorSpec(cfg.optical));
  return { report: r, frontier };
}

test("every preset is a clean machine", () => {
  for (const p of PRESETS) {
    const r = evaluate(p.config);
    const where = `preset ${p.id}`;
    assert.deepEqual(r.faults, [], `${where} faults`);
    assert.deepEqual(r.notes, [], `${where} notes`);
    assert.ok(!r.cpu.throttled && !r.gpu.throttled, `${where} throttles`);
    assert.ok(!r.cpu.runaway && !r.gpu.runaway, `${where} runs away`);
    assert.ok(r.link.up, `${where} link down`);
    assert.equal(r.link.trained, r.link.attempted, `${where} link trained below the requested generation`);
    assert.ok(r.optical.up, `${where} optical down`);
    assert.equal(stable(sanitize(p.config)), stable(p.config), `${where} changed by sanitize`);
  }
});

test("preset ids are unique and the default exists", () => {
  const ids = PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(PRESETS.includes(DEFAULT_PRESET));
});

test("optical eyes keep a margin above the BER target on every preset", () => {
  for (const p of PRESETS) {
    const o = evaluate(p.config).optical;
    assert.ok(o.ber <= 1e-12, `${p.id} BER ${o.ber}`);
    // Q 7.03 is the 1e-12 line. Hold at least 0.4 above it so a small constant change cannot flip a preset.
    assert.ok(o.q >= 7.4, `${p.id} Q ${o.q.toFixed(2)} is too close to the target`);
  }
});

test("the same config always gives the same numbers", () => {
  for (const p of PRESETS) assert.equal(stable(evaluate(p.config)), stable(evaluate(p.config)), p.id);
});

test("heat equals electrical power and every number is finite, across a random sweep", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  const problems: string[] = [];
  for (let i = 0; i < 1500; i++) {
    const c = withConfig(PRESETS[3].config, {
      chipsetId: pick(CHIPSET_ORDER), requestedGen: pick(PCIE_GENS), forceGen: rnd() < 0.5, forceVram: rnd() < 0.3,
      cpu: { arch: pick(CPU_ORDER), cores: 1 + Math.floor(rnd() * 300), threads: 1 + Math.floor(rnd() * 600), ghz: rnd() * 7, load: rnd() },
      gpu: { arch: pick(GPU_ORDER), shaders: Math.floor(rnd() * 40000), tensors: Math.floor(rnd() * 20000), ghz: rnd() * 3.5, format: pick(PRECISIONS), load: rnd() },
      dram: { kind: pick(DRAM_KINDS), gb: rnd() * 3000, megaTransfers: rnd() * 40000 },
      vram: { kind: pick(VRAM_KINDS), gb: rnd() * 300, megaTransfers: rnd() * 40000, busBits: pick(GDDR_BUS_BITS), stacks: Math.floor(rnd() * 10) },
      optical: {
        enabled: rnd() < 0.8, band: rnd() < 0.8 ? "c1550" : "o1310", lanes: 1 + Math.floor(rnd() * 40), gbitPerLane: rnd() * 130,
        track: rnd() < 0.8, modulator: pick(MODULATOR_IDS), modLengthMm: rnd() * 14 - 1, modSwingV: rnd() * 9 - 1,
      },
      cpuCooler: pick(COOLER_IDS), gpuCooler: pick(COOLER_IDS), ambientC: 5 + rnd() * 45,
    });
    for (const f of [(x: BenchConfig) => x, fitMemory, ratedLink]) {
      const r = evaluate(f(c));
      const bad = nonFinite({ ...r, notes: undefined, faults: undefined });
      if (bad.length) problems.push(`#${i} ${bad[0]}`);
      if (r.heatW !== r.electricalW) problems.push(`#${i} energy balance ${r.heatW} vs ${r.electricalW}`);
    }
  }
  assert.deepEqual(problems.slice(0, 5), []);
});

test("sanitize clamps hostile input to the documented limits", () => {
  const hostile = withConfig(PRESETS[3].config, {
    optical: { gbitPerLane: 1e6, lanes: -5, modulator: "bogus" as ModulatorId, modLengthMm: Number.NaN, modSwingV: 99 },
    cpu: { cores: 1e9, threads: -3, ghz: Number.NaN },
  });
  const s = sanitize(hostile);
  assert.ok(s.optical.gbitPerLane >= 2.5 && s.optical.gbitPerLane <= 112);
  assert.ok(MODULATOR_IDS.includes(s.optical.modulator));
  assert.ok(s.optical.modLengthMm >= MODULATOR_LENGTH_MM.min && s.optical.modLengthMm <= MODULATOR_LENGTH_MM.max);
  assert.ok(s.optical.modSwingV >= MODULATOR_SWING_V.min && s.optical.modSwingV <= MODULATOR_SWING_V.max);
  assert.ok(s.cpu.cores <= 256 && s.cpu.threads <= 512);
  assert.deepEqual(nonFinite(evaluate(hostile)), []);
});

test("each PCIe generation uses its own insertion-loss mask", () => {
  const expected: Record<string, number> = { "1.0": 13, "2.0": 17, "3.0": 22, "4.0": 28, "5.0": 36, "6.0": 32, "7.0": 36 };
  for (const gen of PCIE_GENS) {
    const r = evaluate(withConfig(PRESETS[3].config, { requestedGen: gen, forceGen: true }));
    assert.equal(r.link.budgetDb, expected[gen], `Gen ${gen}`);
  }
});

test("the modulator never swings past its half-wave voltage and a longer one is slower", () => {
  for (const id of MODULATOR_IDS) {
    const base = withConfig(PRESETS[3].config, { optical: { modulator: id, modLengthMm: 3, modSwingV: 6 } });
    const longer = withConfig(base, { optical: { modLengthMm: 9 } });
    const a = evaluate(base).optical.modulator;
    const b = evaluate(longer).optical.modulator;
    assert.ok(a.swingV <= a.vpiV + 1e-9, `${id} swing above Vπ`);
    assert.ok(b.vpiV < a.vpiV, `${id} longer section needs less voltage`);
    assert.ok(b.bandwidthGhz < a.bandwidthGhz, `${id} longer section is slower`);
  }
});

test("copper gets costlier and optical eyes get smaller as the run grows", () => {
  const { frontier } = sweep(PRESETS[3].config, "tfln");
  const rows = (m: string) => frontier.rows.filter((x) => x.medium === m);
  const cu = rows("copper"), op = rows("optical");
  for (let i = 1; i < cu.length; i++) assert.ok(cu[i].energyPj >= cu[i - 1].energyPj - 1e-9, `copper energy falls at ${cu[i].lengthCm} cm`);
  assert.ok(op[op.length - 1].q < op[0].q, "optical Q should fall with length");
  assert.ok(cu[cu.length - 1].q < cu[0].q, "copper Q should fall with length");
});

// Regression snapshot. If a model change moves these on purpose, update them and say why in the commit.
test("copper-versus-optical crossover snapshot (cm, null = none)", () => {
  const expected: Record<string, Record<ModulatorId, number | null>> = {
    ddr2: { si: null, tfln: 26, eop: 26 },
    ddr3: { si: 14, tfln: 8, eop: 4 },
    ddr4: { si: null, tfln: 8, eop: 4 },
    ddr5: { si: null, tfln: null, eop: 10 },
    arrow: { si: null, tfln: null, eop: 10 },
    storm: { si: null, tfln: null, eop: 10 },
    gen7: { si: null, tfln: null, eop: 10 },
  };
  for (const p of PRESETS) {
    for (const id of MODULATOR_IDS) {
      const got = sweep(p.config, id).frontier.crossoverCm ?? null;
      assert.equal(got, expected[p.id][id], `${p.id} ${id}`);
    }
  }
});
