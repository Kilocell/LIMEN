import { memo, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  analyze,
  CHIPSETS,
  CHIPSET_ORDER,
  COOLERS,
  COOLER_IDS,
  CPU_ARCH,
  CPU_ORDER,
  DEFAULT_PRESET,
  DRAM_KINDS,
  DRAM_SPEC,
  GPU_ARCH,
  GPU_ORDER,
  PCIE_GENS,
  PRECISIONS,
  PRESETS,
  THREAD_MAX,
  VRAM_KINDS,
  VRAM_SPEC,
  GDDR_BUS_BITS,
  MODULATORS,
  MODULATOR_IDS,
  MODULATOR_LENGTH_MM,
  MODULATOR_SWING_V,
  driftCurve,
  fitMemory,
  modulatorSpec,
  ratedLink,
  sanitize,
  simulateOptical,
  spectrumDb,
  withConfig,
  type BenchConfig,
  type ChipsetId,
  type CoolerId,
  type CpuArchId,
  type DieMap,
  type DieRole,
  type DramKind,
  type GpuArchId,
  type LinkRow,
  type ModulatorId,
  type OpticalBand,
  type PcieGen,
  type Precision,
  type VramKind,
} from "@/lib/limen";
import { sci } from "@/lib/format";
import { assess, ratingLabel, rowAt } from "@/lib/assess";
import { ReportBlock, StatusBlock, useSensitivity } from "./status-panel";

type ModuleId = "cpu" | "gpu" | "dram" | "vram" | "link" | "optical";

const FORMAT_LABEL: Record<Precision, string> = {
  fp64: "FP64",
  fp32: "FP32",
  tf32: "TF32",
  fp16: "FP16",
  bf16: "BF16",
  fp8: "FP8",
  int8: "INT8",
};

function gbPerSec(bytes: number): string {
  if (bytes <= 0) return "0";
  const gb = bytes / 1e9;
  return gb >= 100 ? gb.toFixed(0) : gb.toFixed(2);
}

function tera(ops: number | null): string {
  if (ops === null) return "—";
  const value = ops / 1e12;
  if (value >= 100) return value.toFixed(0);
  // Old parts run at a few GFLOP/s; one decimal would print them as 0.0.
  return value >= 0.1 ? value.toFixed(1) : value.toFixed(2);
}

function watts(value: number): string {
  const safe = Math.max(0, value);
  return safe >= 100 ? safe.toFixed(0) : safe.toFixed(1);
}

function mhz(hz: number): string {
  return (hz / 1e6).toFixed(0);
}

function extentNm(die: DieMap): string {
  return `${sci(die.widthNm)} × ${sci(die.heightNm)} nm`;
}

const HEAT_COOL = [125, 206, 198] as const;
const HEAT_WARM = [224, 164, 74] as const;
const HEAT_HOT = [212, 83, 62] as const;

/** Cool cyan → amber → alert. `fraction` is 0 at ambient and 1 at the junction limit. */
function heatColor(fraction: number): string {
  const t = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  const hotSide = t >= 0.55;
  const from = hotSide ? HEAT_WARM : HEAT_COOL;
  const to = hotSide ? HEAT_HOT : HEAT_WARM;
  const u = hotSide ? (t - 0.55) / 0.45 : t / 0.55;
  const r = Math.round(from[0] + (to[0] - from[0]) * u);
  const g = Math.round(from[1] + (to[1] - from[1]) * u);
  const b = Math.round(from[2] + (to[2] - from[2]) * u);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Plume radius grows with package power so a hot config covers more of the board. */
function plumeRadius(wattsValue: number, base: number): number {
  return base + Math.min(110, Math.sqrt(Math.max(wattsValue, 1)) * 6);
}

function traceOf(wave: Float64Array): number[] {
  const want = 64;
  const step = Math.max(1, Math.floor(wave.length / want));
  const raw: number[] = [];
  for (let i = 0; i < wave.length && raw.length < want; i += step) raw.push(wave[i]);
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of raw) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const span = hi - lo;
  if (!(span > 0)) return raw.map(() => 0);
  return raw.map((value) => (value - lo) / span);
}

function chartPoints(values: readonly number[], width: number, height: number, lo: number, hi: number): string {
  const span = Math.max(hi - lo, 1e-9);
  const last = Math.max(values.length - 1, 1);
  let out = "";
  for (let i = 0; i < values.length; i++) {
    if (i) out += " ";
    const x = (i / last) * width;
    const y = height - 3 - ((values[i] - lo) / span) * (height - 6);
    out += `${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return out;
}

function eyePoints(samples: readonly number[], width: number, height: number): string {
  return chartPoints(samples, width, height, 0, 1);
}


const ROLE_FILL: Record<DieRole, string> = {
  core: "var(--color-sin)",
  ecore: "#4ea8a1",
  l3: "#24302e",
  l2: "#2c261c",
  iod: "#3c3426",
  sm: "var(--color-polymer)",
  tensor: "#f3d7a4",
  phy: "var(--color-ok)",
};

const DRAW_ORDER: Record<DieRole, number> = {
  iod: 0,
  l3: 1,
  l2: 1,
  phy: 2,
  ecore: 3,
  core: 4,
  sm: 5,
  tensor: 6,
};

const DieFloor = memo(function DieFloor({
  die,
  x,
  y,
  w,
  h,
  heatOn,
  ambient,
  tMax,
}: {
  die: DieMap;
  x: number;
  y: number;
  w: number;
  h: number;
  heatOn: boolean;
  ambient: number;
  tMax: number;
}) {
  const lip = 3;
  const availW = Math.max(8, w - lip * 2);
  const availH = Math.max(8, h - lip * 2);
  const aspect = die.widthMm / Math.max(die.heightMm, 1e-6);
  const dw = aspect > availW / availH ? availW : availH * aspect;
  const dh = aspect > availW / availH ? availW / aspect : availH;
  const sx = x + (w - dw) / 2;
  const sy = y + (h - dh) / 2;
  const span = Math.max(1, tMax - ambient);
  const blocks = useMemo(
    () => [...die.blocks].sort((left, right) => DRAW_ORDER[left.role] - DRAW_ORDER[right.role]),
    [die.blocks],
  );
  const dense = blocks.length > 48;
  return (
    <g>
      <rect x={sx - lip} y={sy - lip} width={dw + lip * 2} height={dh + lip * 2} className="die-substrate" />
      <rect x={sx - lip + 0.7} y={sy - lip + 0.7} width={dw + lip * 2 - 1.4} height={dh + lip * 2 - 1.4} className="die-seal" />
      {blocks.map((block) => {
        const bx = sx + block.x * dw;
        const by = sy + block.y * dh;
        const bw = Math.max(0.7, block.w * dw);
        const bh = Math.max(0.7, block.h * dh);
        const fill = heatOn ? heatColor((block.tempC - ambient) / span) : ROLE_FILL[block.role];
        const bare = dense && block.role !== "iod" && block.role !== "l3" && block.role !== "l2";
        if (bare) {
          return (
            <rect
              key={block.id}
              x={bx}
              y={by}
              width={bw}
              height={bh}
              fill={fill}
              stroke="#101210"
              strokeWidth={block.role === "tensor" ? 0.15 : 0.35}
            />
          );
        }
        const macro = bw >= 7 && bh >= 7;
        const label =
          block.role === "iod" && bw >= 34 && bh >= 12 ? "IOD" : block.role === "l3" && bw >= 14 && bh >= 11 ? "L3" : block.role === "l2" && bh >= 16 && bw >= 8 ? "L2" : null;
        const bumps = block.role === "iod" && macro ? Math.min(8, Math.max(3, Math.floor(bw / 14))) : 0;
        return (
          <g key={block.id}>
            <rect x={bx} y={by} width={bw} height={bh} fill={fill} stroke="#101210" strokeWidth={0.4}>
              {/* One string child: React 19 renders a multi-child <title> empty on the server, which breaks hydration. */}
              <title>{`${block.role} ${sci(block.areaNm2)} nm² · ${block.powerW.toFixed(2)} W · ${block.tempC.toFixed(1)} °C`}</title>
            </rect>
            {(block.role === "l3" || block.role === "l2") && Math.max(bw, bh) >= 8 && Math.min(bw, bh) >= 1.6 ? (
              <rect x={bx} y={by} width={bw} height={bh} fill="url(#die-cache)" />
            ) : null}
            {macro && (block.role === "core" || block.role === "ecore" || block.role === "sm") ? (
              <rect
                x={bx + bw * 0.16}
                y={by + bh * (block.role === "sm" ? 0.1 : 0.18)}
                width={bw * 0.68}
                height={bh * (block.role === "sm" ? 0.38 : 0.64)}
                fill="#070808"
                opacity={0.38}
              />
            ) : null}
            {bumps > 0
              ? Array.from({ length: bumps }, (_, index) => {
                  const slot = bw / (bumps + 0.3);
                  return (
                    <rect
                      key={index}
                      x={bx + slot * 0.35 + index * slot}
                      y={by + bh - Math.min(5.5, bh * 0.2)}
                      width={Math.max(1.1, slot * 0.5)}
                      height={Math.min(4.5, bh * 0.14)}
                      fill="#070808"
                      opacity={0.45}
                    />
                  );
                })
              : null}
            {block.role === "phy" && bw >= 3.5 && bh >= 2.5 ? (
              <rect x={bx + bw * 0.18} y={by + bh * 0.15} width={bw * 0.64} height={bh * 0.7} fill="#070808" opacity={0.35} />
            ) : null}
            {label ? (
              <text x={bx + bw / 2} y={by + bh * 0.42} textAnchor="middle" dominantBaseline="middle" className="die-label">
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
});

type PhaseView = {
  spectrum: { wl: number[]; db: number[] };
  drift: { tempC: number[]; peakUm: number[]; il1550: number[] };
  frontier: { rows: LinkRow[]; crossoverCm: number | null };
  eyes: { nrz: number[]; pam4: number[] };
};

function PhaseBench({ phase, lengthCm, laminate }: { phase: PhaseView; lengthCm: number; laminate: string }) {
  const optical = phase.frontier.rows.filter((row) => row.medium === "optical");
  const copper = phase.frontier.rows.filter((row) => row.medium === "copper");
  const pj = optical.map((row) => row.energyPj).concat(copper.map((row) => row.energyPj));
  const lo = Math.min(...pj);
  const hi = Math.max(...pj);
  const ilLo = Math.min(...phase.spectrum.db);
  const ilHi = Math.max(...phase.spectrum.db);
  const driftLo = Math.min(...phase.drift.il1550);
  const driftHi = Math.max(...phase.drift.il1550);
  const hereO = rowAt(phase.frontier.rows, "optical", lengthCm);
  const hereC = rowAt(phase.frontier.rows, "copper", lengthCm);
  const cross = phase.frontier.crossoverCm;
  const crossX = cross === null ? null : ((cross - 2) / 58) * 160;
  const hotPeak = phase.drift.peakUm[phase.drift.peakUm.length - 1] ?? 1.55;
  return (
    <section className="phase-bench">
      <h3>Spectral transmission</h3>
      <svg className="phase-chart" viewBox="0 0 160 42" role="img" aria-label="C-band insertion loss">
        <polyline className="is-optical" fill="none" stroke="currentColor" strokeWidth="1.2" points={chartPoints(phase.spectrum.db, 160, 42, ilLo, ilHi)} />
      </svg>
      <p className="phase-meta">
        <span>1.548 µm</span>
        <span>{ilLo.toFixed(1)}–{ilHi.toFixed(1)} dB</span>
        <span>1.553 µm</span>
      </p>
      <h3>MRR drift at 1550 nm</h3>
      <svg className="phase-chart" viewBox="0 0 160 42" role="img" aria-label="Ring drift versus temperature">
        <polyline className="is-copper" fill="none" stroke="currentColor" strokeWidth="1.2" points={chartPoints(phase.drift.il1550, 160, 42, driftLo, driftHi)} />
      </svg>
      <p className="phase-meta">
        <span>25 °C</span>
        <span>peak {hotPeak.toFixed(4)} µm at 95 °C</span>
        <span>95 °C</span>
      </p>
      <h3>NRZ and PAM4 eyes</h3>
      <div className="phase-eyes">
        {phase.eyes.nrz.length > 2 ? (
          <>
            <svg className="phase-chart" viewBox="0 0 160 42" role="img" aria-label="NRZ eye">
              <polyline className="is-optical" fill="none" stroke="currentColor" strokeWidth="1.1" points={eyePoints(phase.eyes.nrz, 160, 42)} />
            </svg>
            <svg className="phase-chart" viewBox="0 0 160 42" role="img" aria-label="PAM4 eye">
              <polyline className="is-copper" fill="none" stroke="currentColor" strokeWidth="1.1" points={eyePoints(phase.eyes.pam4, 160, 42)} />
            </svg>
          </>
        ) : (
          <p className="phase-meta">C-band eye is off. O-band does not drive the 1550 nm ring.</p>
        )}
      </div>
      <h3>Copper versus optical</h3>
      <svg className="phase-chart" viewBox="0 0 160 42" role="img" aria-label="Energy frontier">
        {crossX !== null ? <line x1={crossX} y1="2" x2={crossX} y2="40" stroke="currentColor" strokeOpacity="0.45" /> : null}
        <polyline className="is-optical" fill="none" stroke="currentColor" strokeWidth="1.2" points={chartPoints(optical.map((row) => row.energyPj), 160, 42, lo, hi)} />
        <polyline className="is-copper" fill="none" stroke="currentColor" strokeWidth="1.2" points={chartPoints(copper.map((row) => row.energyPj), 160, 42, lo, hi)} />
      </svg>
      <p className="phase-meta">
        <span>{laminate === "fr4" ? "FR-4" : "Megtron"}</span>
        <span>{cross === null ? "no crossover in 2–60 cm" : `optics win from ${cross.toFixed(0)} cm`}</span>
        <span>
          {hereO ? `${hereO.energyPj.toFixed(2)}` : "—"} / {hereC ? `${hereC.energyPj.toFixed(2)} pJ/bit` : "—"}
        </span>
      </p>
    </section>
  );
}

export function Dashboard() {
  const [config, setConfig] = useState<BenchConfig>(() => sanitize(DEFAULT_PRESET.config));
  const [presetId, setPresetId] = useState(DEFAULT_PRESET.id);
  const [selected, setSelected] = useState<ModuleId>("link");
  // Board modules are SVG groups: give each one a button role, a tab stop and Enter/Space activation.
  const moduleProps = (id: ModuleId, label: string) => ({
    role: "button" as const,
    tabIndex: 0,
    "aria-label": label,
    "aria-pressed": selected === id,
    onClick: () => setSelected(id),
    onKeyDown: (event: KeyboardEvent<SVGElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setSelected(id);
      }
    },
  });
  const [heatOn, setHeatOn] = useState(true);
  const analysis = useMemo(() => analyze(config), [config]);
  const report = analysis.report;
  const sensitivity = useSensitivity(config);
  const assessment = useMemo(
    () => assess(report, analysis.frontier, sensitivity.result?.verdict),
    [report, analysis, sensitivity.result],
  );
  const activePreset = PRESETS.find((preset) => preset.id === presetId)?.label ?? null;
  const statusText = [report.link.reason, report.optical.reason, report.notes.join(" ")].filter(Boolean).join(" ");
  // Announce the settled state, not every slider tick.
  const [announced, setAnnounced] = useState(statusText);
  useEffect(() => {
    const id = setTimeout(() => setAnnounced(statusText), 700);
    return () => clearTimeout(id);
  }, [statusText]);
  // On narrow screens the presets scroll sideways; keep the active one in view.
  useEffect(() => {
    document.querySelector(".fabric-presets .is-on")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [presetId]);
  const phase = useMemo(() => {
    const { rises, frontier } = analysis;
    const rate = config.optical.gbitPerLane * 1e9;
    const track = config.optical.band === "c1550" && config.optical.track;
    const spectrum = spectrumDb(report.chipset.traceCm, rises, 1.548, 1.553, 61);
    const drift = driftCurve(report.chipset.traceCm, rises.wg, rises.hot, rises.cold);
    const modulator = modulatorSpec(config.optical);
    const live = config.optical.enabled && config.optical.band === "c1550";
    const eyes = live
      ? {
          nrz: traceOf(simulateOptical(report.chipset.traceCm, rate, "ook", rises, track, modulator, 128, 8).wave),
          pam4: traceOf(simulateOptical(report.chipset.traceCm, rate, "pam4", rises, track, modulator, 128, 8).wave),
        }
      : { nrz: [] as number[], pam4: [] as number[] };
    return { spectrum, drift, frontier, eyes };
  }, [analysis, config, report]);

  function edit(patch: Parameters<typeof withConfig>[1]) {
    setPresetId("");
    setConfig((prev) => withConfig(prev, patch));
  }

  const laneColor = !report.link.up
    ? "var(--color-alert)"
    : PCIE_GENS.indexOf(report.link.attempted) >= PCIE_GENS.indexOf("6.0")
      ? "var(--color-sin)"
      : "var(--color-polymer)";
  const cpuHeat = Math.min(1, Math.max(0, (report.cpu.junctionC - config.ambientC) / Math.max(1, report.cpu.tMaxC - config.ambientC)));
  const gpuHeat = Math.min(1, Math.max(0, (report.gpu.junctionC - config.ambientC) / Math.max(1, report.gpu.tMaxC - config.ambientC)));
  const parts = [
    { id: "cpu", label: "CPU", watts: Math.max(0, report.cpu.watts - report.link.endpointW), color: "var(--color-sin)" },
    { id: "gpu", label: "GPU", watts: Math.max(0, report.gpu.asicW), color: "var(--color-polymer)" },
    { id: "vram", label: "VRAM", watts: report.vram.watts, color: "#e0b56a" },
    { id: "dram", label: "DRAM", watts: report.dram.watts, color: "var(--color-ok)" },
    { id: "link", label: "x16", watts: report.link.endpointW * 2 + report.link.retimerW, color: "#d5e4e1" },
    { id: "optical", label: "Optical", watts: report.optical.watts, color: "var(--color-sin)" },
    { id: "pch", label: "PCH", watts: report.pchW, color: "#6d8f88" },
    { id: "fan", label: "Fans", watts: report.fanW, color: "#c8c2b4" },
  ];
  const total = Math.max(report.electricalW, 1e-9);
  const threadMax = Math.min(THREAD_MAX, config.cpu.cores * CPU_ARCH[config.cpu.arch].smt);
  const dimmCount = report.chipset.memChannels;
  const vramChips = config.vram.kind === "hbm" ? config.vram.stacks : Math.max(2, Math.round(config.vram.busBits / 32));
  const cpuSpread = plumeRadius(report.cpu.watts, 70);
  const gpuSpread = plumeRadius(report.gpu.asicW + report.vram.watts, 78);

  return (
    <main className="fabric">
      <header className="fabric-bar">
        <div className="fabric-id">
          <span className="brand-mark">LIMEN</span>
          <span className="brand-sub">link investigator / electro-optic near-reach</span>
        </div>
        <div className="fabric-presets" role="group" aria-label="Setups">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={presetId === preset.id ? "is-on" : ""} aria-pressed={presetId === preset.id}
              onClick={() => {
                setPresetId(preset.id);
                setConfig(sanitize(preset.config));
              }}
            >
              <strong>{preset.label}</strong>
              <span>{preset.detail}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`status-chip rate-${assessment.overall}`}
          onClick={() => document.getElementById("link-status")?.scrollIntoView({ block: "start" })}
          aria-label={`Link status: ${ratingLabel("overall", assessment.overall)}. Show details`}
        >
          Link · {ratingLabel("overall", assessment.overall)}
        </button>
        <button
          type="button"
          className={`heat-toggle${heatOn ? " is-on" : ""}`}
          aria-pressed={heatOn}
          onClick={() => setHeatOn((on) => !on)}
        >
          Heat {heatOn ? "on" : "off"}
        </button>
      </header>

      <div className="fabric-main">
        <section className="fabric-board" aria-label="Motherboard">
          <svg
            viewBox="0 0 960 460"
            className="fabric-svg"
            role="group"
            aria-label={`${report.chipset.label}, x${report.link.lanes} Gen ${report.link.attempted}, ${report.link.up ? "trained" : "down"}, optical ${report.optical.enabled ? `${report.optical.wavelengthNm.toFixed(1)} nm ${report.optical.up ? "open" : "closed"}` : "off"}${heatOn ? `, CPU ${report.cpu.junctionC.toFixed(1)} °C, GPU ${report.gpu.junctionC.toFixed(1)} °C` : ""}`}
          >
            <defs>
              <radialGradient id="cpu-plume" cx="154" cy="240" r={cpuSpread} gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor={heatColor(cpuHeat)} stopOpacity="0.9" />
                <stop offset="38%" stopColor={heatColor(cpuHeat * 0.7)} stopOpacity="0.5" />
                <stop offset="100%" stopColor={heatColor(0.05)} stopOpacity="0" />
              </radialGradient>
              <radialGradient id="gpu-plume" cx="812" cy="260" r={gpuSpread} gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor={heatColor(gpuHeat)} stopOpacity="0.9" />
                <stop offset="38%" stopColor={heatColor(gpuHeat * 0.7)} stopOpacity="0.5" />
                <stop offset="100%" stopColor={heatColor(0.05)} stopOpacity="0" />
              </radialGradient>
              <linearGradient id="heat-scale" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={heatColor(0)} />
                <stop offset="55%" stopColor={heatColor(0.55)} />
                <stop offset="100%" stopColor={heatColor(1)} />
              </linearGradient>
              <pattern id="die-cache" width="3.2" height="2.4" patternUnits="userSpaceOnUse">
                <line x1="0" y1="1.2" x2="3.2" y2="1.2" stroke="#070808" strokeOpacity="0.4" strokeWidth="0.55" />
              </pattern>
            </defs>
            <rect x="18" y="28" width="924" height="404" className="board-plate" />
            <text x="36" y="52" className="svg-kicker">
              {report.chipset.label} · {report.chipset.family}
            </text>
            <text x="36" y="70" className="svg-quiet">
              {report.chipset.traceCm} cm {report.chipset.laminate === "fr4" ? "FR-4" : "Megtron"} · rated Gen {report.chipset.pegGen} · {report.chipset.maxRetimers} retimer
              {report.chipset.maxRetimers === 1 ? "" : "s"}
            </text>

            <g {...moduleProps("dram", "CPU memory")}>
            {Array.from({ length: dimmCount }, (_, index) => {
              const x = 78 + (index % 8) * 22;
              const y = index < 8 ? 86 : 108;
              return (
                <rect
                  key={index}
                  x={x}
                  y={y}
                  width="14"
                  height="36"
                  className={report.dram.trained ? "dimm-on" : "dimm-off"}
                />
              );
            })}
            </g>

            <g {...moduleProps("cpu", "CPU")} className={selected === "cpu" ? "mod-on" : ""}>
              <rect x="70" y="156" width="168" height="196" className="socket" />
              {heatOn ? (
                <ellipse cx="154" cy="248" rx={cpuSpread} ry={cpuSpread * 0.72} fill="url(#cpu-plume)" pointerEvents="none" />
              ) : null}
              <text x="154" y="168" textAnchor="middle" className="svg-nm">
                CPU · {report.cpuArch.processNm} nm node
              </text>
              <text x="154" y="180" textAnchor="middle" className="svg-nm">
                {extentNm(report.cpu.die)}
              </text>
              <DieFloor
                die={report.cpu.die}
                x={84}
                y={188}
                w={140}
                h={116}
                heatOn={heatOn}
                ambient={config.ambientC}
                tMax={report.cpu.tMaxC}
              />
              <text x="154" y="322" textAnchor="middle" className="svg-die-sub">
                {config.cpu.cores}c / {config.cpu.threads}t · {report.cpu.deliveredGhz.toFixed(2)} GHz
              </text>
              {heatOn ? (
                <text x="154" y="338" textAnchor="middle" className="svg-heat">
                  {report.cpu.die.coolestC.toFixed(0)}–{report.cpu.junctionC.toFixed(1)} °C
                  {report.cpu.runaway ? " · thermal trip" : report.cpu.throttled ? " · throttle" : ""}
                </text>
              ) : null}
            </g>

            <g {...moduleProps("link", "PCIe link")}>
              {Array.from({ length: 16 }, (_, index) => {
                const y = 176 + index * 10;
                return (
                  <line
                    key={index}
                    x1="248"
                    y1={y}
                    x2="692"
                    y2={y}
                    stroke={laneColor}
                    strokeWidth={report.link.up ? 2 : 1.4}
                    strokeDasharray={report.link.up ? undefined : "5 4"}
                    opacity={report.link.up ? 0.9 : 0.7}
                  />
                );
              })}
              {report.link.up && report.link.retimers > 0
                ? Array.from({ length: report.link.retimers }, (_, index) => {
                    const x = report.link.retimers === 1 ? 470 : 430 + index * 80;
                    return <rect key={index} x={x - 7} y="168" width="14" height="168" className="retimer" />;
                  })
                : null}
              <text x="470" y="156" textAnchor="middle" className="svg-kicker">
                x{report.link.lanes} · Gen {report.link.attempted}
                {report.link.up ? "" : " · DOWN"}
              </text>
            </g>

            <g {...moduleProps("optical", "On-board optical")}>
              {Array.from({ length: Math.min(8, report.optical.lanes) }, (_, index) => {
                const y0 = 336 + index * 2;
                const sag = 416 - index;
                const tone = report.optical.up ? "waveguide" : report.optical.enabled ? "waveguide is-down" : "waveguide is-off";
                return <path key={index} d={`M 238 ${y0} C 360 ${sag}, 600 ${sag}, 698 ${y0}`} className={tone} />;
              })}
              <path d="M 232 334 L 232 352" className="grating" />
              <path d="M 704 334 L 704 352" className="grating" />
              <circle cx="688" cy="340" r="6" className="ring-mark" />
              <circle cx="688" cy="340" r="2.6" className="ring-mark" />
              <text x="470" y="144" textAnchor="middle" className="svg-nm">
                {report.optical.enabled
                  ? `${report.optical.lanes}× ${report.optical.wavelengthNm.toFixed(1)} nm · ${report.optical.ilDb.toFixed(1)} dB`
                  : "optical off"}
              </text>
            </g>

            <g onClick={() => setSelected("link")} className={selected === "link" ? "mod-on" : ""}>
              <rect x="430" y="360" width="100" height="48" className="pch" />
              <text x="480" y="380" textAnchor="middle" className="svg-die-sub">
                PCH
              </text>
              <text x="480" y="396" textAnchor="middle" className="svg-quiet">
                {watts(report.pchW)} W
              </text>
            </g>

            <g {...moduleProps("gpu", "GPU")} className={selected === "gpu" ? "mod-on" : ""}>
              <rect x="700" y="150" width="210" height="230" className="socket" />
              {heatOn ? (
                <ellipse cx="812" cy="268" rx={gpuSpread} ry={gpuSpread * 0.7} fill="url(#gpu-plume)" pointerEvents="none" />
              ) : null}
              <DieFloor
                die={report.gpu.die}
                x={712}
                y={188}
                w={186}
                h={140}
                heatOn={heatOn}
                ambient={config.ambientC}
                tMax={report.gpu.tMaxC}
              />
              <text x="805" y="342" textAnchor="middle" className="svg-nm">
                GPU · {report.gpuArch.processNm} nm node
              </text>
              <text x="805" y="354" textAnchor="middle" className="svg-nm">
                {extentNm(report.gpu.die)}
              </text>
              {heatOn ? (
                <text x="805" y="370" textAnchor="middle" className="svg-heat">
                  {report.gpu.die.coolestC.toFixed(0)}–{report.gpu.junctionC.toFixed(1)} °C
                  {report.gpu.runaway ? " · thermal trip" : report.gpu.throttled ? " · throttle" : ""}
                </text>
              ) : null}
            </g>

            <g {...moduleProps("vram", "GPU memory")}>
            {Array.from({ length: Math.min(vramChips, 8) }, (_, index) => (
              <rect
                key={index}
                x={714 + (index % 8) * 22}
                y="162"
                width="16"
                height="22"
                className={report.vram.trained ? "vram-on" : "dimm-off"}
              />
            ))}
            </g>
            {heatOn ? (
              <g pointerEvents="none">
                <text x="620" y="48" className="svg-quiet">
                  Junction overlay
                </text>
                <rect x="620" y="56" width="150" height="8" fill="url(#heat-scale)" />
                <text x="620" y="78" className="svg-quiet">
                  {config.ambientC.toFixed(0)} °C
                </text>
                <text x="770" y="78" textAnchor="end" className="svg-quiet">
                  limit
                </text>
              </g>
            ) : null}
          </svg>
          {report.faults.length > 0 ? (
            <div className="fabric-fault" role="alert">
              {report.faults.map((fault) => (
                <p key={fault.domain}>{fault.reason}</p>
              ))}
              <div className="fabric-fault-actions">
                {report.faults.some((fault) => fault.domain === "link") ? (
                  <button type="button" onClick={() => { setPresetId(""); setConfig(ratedLink(config)); }}>
                    Train at rated generation
                  </button>
                ) : null}
                {report.faults.some((fault) => fault.domain === "dram" || fault.domain === "vram") ? (
                  <button type="button" onClick={() => { setPresetId(""); setConfig(fitMemory(config)); }}>
                    Fit memory to the modules
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        <aside className="fabric-read" aria-label="Results">
          <p className="fabric-eq">
            <span>{watts(report.electricalW)} W in</span>
            <span>=</span>
            <span>{watts(report.heatW)} W heat</span>
          </p>
          <div className="stackbar" aria-hidden="true">
            {parts.map((part) => (
              <span key={part.id} style={{ width: `${(part.watts / total) * 100}%`, background: part.color }} />
            ))}
          </div>
          <ul className="part-list">
            {parts.map((part) => (
              <li key={part.id}>
                <i style={{ background: part.color }} />
                {part.label}
                <b>{watts(part.watts)}</b>
              </li>
            ))}
          </ul>

          <StatusBlock assessment={assessment} />

          <dl className="readout">
            <div>
              <dt>Link</dt>
              <dd>{report.link.up ? `${gbPerSec(report.link.bytesPerSecEachWay)} GB/s each way` : "0 GB/s"}</dd>
            </div>
            <div>
              <dt>Both ways</dt>
              <dd>{report.link.up ? `${gbPerSec(report.link.bytesPerSecEachWay * 2)} GB/s` : "down"}</dd>
            </div>
            <div>
              <dt>Loss / mask</dt>
              <dd>
                {report.link.ilDb.toFixed(1)} / {report.link.budgetDb.toFixed(0)} dB
              </dd>
            </div>
            <div>
              <dt>Retimers</dt>
              <dd>{report.link.retimers}</dd>
            </div>
            <div>
              <dt>Latency</dt>
              <dd>{report.link.up ? `${(report.link.latencyS * 1e9).toFixed(2)} ns` : "—"}</dd>
            </div>
            <div>
              <dt>CPU package</dt>
              <dd>
                {watts(report.cpu.watts)} W · {report.cpu.junctionC.toFixed(1)} °C
                {report.cpu.runaway ? " · thermal trip" : report.cpu.throttled ? " · throttle" : ""}
                <span className="hint">
                  {report.cpuArch.processNm} nm · {sci(report.cpu.die.areaNm2)} nm² · {report.cpu.die.densityWPerMm2.toFixed(2)} W/mm²
                </span>
                <span className="hint">{extentNm(report.cpu.die)}</span>
              </dd>
            </div>
            <div>
              <dt>CPU FP64</dt>
              <dd>{tera(report.cpu.flopPerSecDp)} TFLOP/s · {report.cpu.voltage.toFixed(2)} V</dd>
            </div>
            <div>
              <dt>GPU {FORMAT_LABEL[config.gpu.format]}</dt>
              <dd>
                {report.gpu.opsPerSec === null ? "pipe absent" : `${tera(report.gpu.opsPerSec)} ${report.gpu.unit}`}
              </dd>
            </div>
            <div>
              <dt>GPU die</dt>
              <dd>
                {watts(report.gpu.asicW)} W · {report.gpu.junctionC.toFixed(1)} °C
                {report.gpu.runaway ? " · thermal trip" : report.gpu.throttled ? " · throttle" : ""}
                <span className="hint">
                  {report.gpuArch.processNm} nm · {sci(report.gpu.die.areaNm2)} nm² · {report.gpu.die.densityWPerMm2.toFixed(2)} W/mm²
                </span>
                <span className="hint">{extentNm(report.gpu.die)}</span>
              </dd>
            </div>
            <div>
              <dt>DRAM</dt>
              <dd>
                {report.dram.trained
                  ? `${gbPerSec(report.dram.bytesPerSec)} GB/s · ${mhz(report.dram.clockHz)}\u00a0MHz\u00a0CK`
                  : "not trained"}
              </dd>
            </div>
            <div>
              <dt>VRAM</dt>
              <dd>
                {report.vram.trained
                  ? `${gbPerSec(report.vram.bytesPerSec)} GB/s · ${mhz(report.vram.clockHz)}\u00a0MHz\u00a0CK`
                  : "not trained"}
              </dd>
            </div>
            <div>
              <dt>Optical</dt>
              <dd>
                {report.optical.enabled
                  ? `${report.optical.wavelengthNm.toFixed(2)} nm · ${report.optical.up ? "open" : "closed"}`
                  : "off"}
                <span className="hint">
                  {report.optical.ilDb.toFixed(2)} / {report.optical.budgetDb.toFixed(0)} dB · Δλ {report.optical.shiftNm.toFixed(2)} nm
                </span>
              </dd>
            </div>
            <div>
              <dt>Eye</dt>
              <dd>
                {report.optical.enabled && report.optical.band === "c1550"
                  ? `Q ${report.optical.q.toFixed(1)} · BER ${report.optical.ber.toExponential(1)}`
                  : report.optical.enabled
                    ? "O-band, ring is 1550 nm"
                    : "—"}
                <span className="hint">
                  {report.optical.lanes}× {report.optical.format.toUpperCase()} {report.optical.gbitPerLane.toFixed(Number.isInteger(report.optical.gbitPerLane) ? 0 : 1)} Gbit/s · {report.optical.energyPj.toFixed(2)} pJ/bit · {(report.optical.latencyPs / 1e3).toFixed(2)} ns
                </span>
              </dd>
            </div>
            <div>
              <dt>Modulator</dt>
              <dd>
                {report.optical.enabled
                  ? `${report.optical.modulator.label} · ${report.optical.modulator.lengthMm.toFixed(1)}\u00a0mm`
                  : "off"}
                {report.optical.enabled ? (
                  <span className="hint">
                    Vπ {report.optical.modulator.vpiV.toFixed(1)} V · {report.optical.modulator.swingV.toFixed(1)} Vpp
                    {report.optical.modulator.swingCapped ? " (capped)" : ""} · ER {report.optical.modulator.erDb.toFixed(1)} dB · IL {report.optical.modulator.ilDb.toFixed(1)} dB · {report.optical.modulator.bandwidthGhz.toFixed(0)} GHz · drive {report.optical.modulator.driveEnergyPj.toFixed(2)} pJ/bit · laser {report.optical.modulator.laserMw.toFixed(1)} mW/lane
                    {report.optical.modulator.laserLimited ? " (limit)" : ""}
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Optical payload</dt>
              <dd>{report.optical.enabled && report.optical.up ? `${gbPerSec(report.optical.bytesPerSec)} GB/s each way` : "0 GB/s"}</dd>
            </div>
          </dl>
          {report.optical.eye.length > 2 ? (
            <svg className="eye-plot" viewBox="0 0 144 36" role="img" aria-label="Optical eye">
              <polyline
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                points={report.optical.eye.map((sample, index) => `${((index / (report.optical.eye.length - 1)) * 144).toFixed(1)},${(34 - sample * 32).toFixed(1)}`).join(" ")}
              />
            </svg>
          ) : null}
          <PhaseBench phase={phase} lengthCm={report.chipset.traceCm} laminate={report.chipset.laminate} />

          <ReportBlock report={report} frontier={analysis.frontier} assessment={assessment} presetLabel={activePreset} sensitivity={sensitivity} />

          <table className="fmt-table">
            <caption>GPU peak at the delivered clock</caption>
            <tbody>
              {report.gpu.byFormat.map((row) => (
                <tr key={row.format} className={row.format === config.gpu.format ? "is-on" : ""}>
                  <th>{FORMAT_LABEL[row.format]}</th>
                  <td>{row.opsPerSec === null ? "—" : tera(row.opsPerSec)}</td>
                  <td>{row.opsPerSec === null ? "" : row.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </aside>
      </div>

      <section className="fabric-dock" aria-label="Modules">
        <fieldset className={selected === "link" ? "is-on" : ""} onClick={() => setSelected("link")} onFocus={() => setSelected("link")}>
          <legend>Motherboard</legend>
          <label>
            Chipset
            <select value={config.chipsetId} onChange={(event) => edit({ chipsetId: event.target.value as ChipsetId })}>
              {CHIPSET_ORDER.map((id) => (
                <option key={id} value={id}>
                  {CHIPSETS[id].label} · {CHIPSETS[id].family}
                </option>
              ))}
            </select>
          </label>
          <div className="seg" role="group" aria-label="PCIe generation">
            {PCIE_GENS.map((gen) => (
              <button key={gen} type="button" className={config.requestedGen === gen ? "is-on" : ""} aria-pressed={config.requestedGen === gen} onClick={() => edit({ requestedGen: gen as PcieGen })}>
                {gen}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={config.forceGen} onChange={(event) => edit({ forceGen: event.target.checked })} />
            Force above the rated PHY
          </label>
          <Slider label="Room" min={10} max={45} step={1} value={config.ambientC} unit="°C" onChange={(ambientC) => edit({ ambientC })} />
        </fieldset>

        <fieldset className={selected === "optical" ? "is-on" : ""} onClick={() => setSelected("optical")} onFocus={() => setSelected("optical")}>
          <legend>On-board optical</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={config.optical.enabled}
              onChange={(event) => edit({ optical: { enabled: event.target.checked } })}
            />
            Polymer waveguide and SiN rings
          </label>
          <div className="seg" role="group" aria-label="Optical band">
            {([
              ["c1550", "C 1550"],
              ["o1310", "O 1310"],
            ] as const).map(([band, label]) => (
              <button
                key={band}
                type="button"
                className={config.optical.band === band ? "is-on" : ""} aria-pressed={config.optical.band === band}
                onClick={() => edit({ optical: { band: band as OpticalBand } })}
              >
                {label}
              </button>
            ))}
          </div>
          <Slider
            label="Lanes"
            min={1}
            max={32}
            step={1}
            value={config.optical.lanes}
            unit=""
            onChange={(lanes) => edit({ optical: { lanes } })}
          />
          <Slider
            label="Lane rate"
            min={2.5}
            max={112}
            step={0.5}
            digits={1}
            value={config.optical.gbitPerLane}
            unit="Gbit/s"
            onChange={(gbitPerLane) => edit({ optical: { gbitPerLane } })}
          />
          <label>
            Modulator
            <select
              value={config.optical.modulator}
              onChange={(event) => {
                const id = event.target.value as ModulatorId;
                edit({ optical: { modulator: id, modLengthMm: MODULATORS[id].lengthMm, modSwingV: MODULATORS[id].swingV } });
              }}
            >
              {MODULATOR_IDS.map((id) => (
                <option key={id} value={id}>
                  {MODULATORS[id].label}
                </option>
              ))}
            </select>
          </label>
          <Slider
            label="Modulator length"
            min={MODULATOR_LENGTH_MM.min}
            max={MODULATOR_LENGTH_MM.max}
            step={0.5}
            digits={1}
            value={config.optical.modLengthMm}
            unit="mm"
            onChange={(modLengthMm) => edit({ optical: { modLengthMm } })}
          />
          <Slider
            label="Modulator drive"
            min={MODULATOR_SWING_V.min}
            max={MODULATOR_SWING_V.max}
            step={0.1}
            digits={1}
            value={config.optical.modSwingV}
            unit="Vpp"
            onChange={(modSwingV) => edit({ optical: { modSwingV } })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={config.optical.track}
              onChange={(event) => edit({ optical: { track: event.target.checked } })}
            />
            Track the C-band ring
          </label>
          <p className="hint">{report.optical.reason}</p>
        </fieldset>

        <fieldset className={selected === "cpu" ? "is-on" : ""} onClick={() => setSelected("cpu")} onFocus={() => setSelected("cpu")}>
          <legend>CPU</legend>
          <label>
            Architecture
            <select value={config.cpu.arch} onChange={(event) => edit({ cpu: { arch: event.target.value as CpuArchId } })}>
              {CPU_ORDER.map((id) => (
                <option key={id} value={id}>
                  {CPU_ARCH[id].label} · {CPU_ARCH[id].processNm} nm · PHY {CPU_ARCH[id].ioGen}
                </option>
              ))}
            </select>
          </label>
          <Slider label="Cores" min={1} max={256} step={1} value={config.cpu.cores} unit="" onChange={(cores) => edit({ cpu: { cores } })} />
          <Slider label="Threads" min={config.cpu.cores} max={threadMax} step={1} value={config.cpu.threads} unit="" onChange={(threads) => edit({ cpu: { threads } })} />
          <Slider label="Clock" min={CPU_ARCH[config.cpu.arch].fMinHz / 1e9} max={6} step={0.05} value={config.cpu.ghz} unit="GHz" digits={2} onChange={(ghz) => edit({ cpu: { ghz } })} />
          <Slider label="Load" min={0.05} max={1} step={0.01} value={config.cpu.load} unit="" digits={2} onChange={(load) => edit({ cpu: { load } })} />
          <label>
            Cooler
            <select value={config.cpuCooler} onChange={(event) => edit({ cpuCooler: event.target.value as CoolerId })}>
              {COOLER_IDS.map((id) => (
                <option key={id} value={id}>
                  {COOLERS[id].label}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset className={selected === "gpu" ? "is-on" : ""} onClick={() => setSelected("gpu")} onFocus={() => setSelected("gpu")}>
          <legend>GPU</legend>
          <label>
            Architecture
            <select value={config.gpu.arch} onChange={(event) => edit({ gpu: { arch: event.target.value as GpuArchId } })}>
              {GPU_ORDER.map((id) => (
                <option key={id} value={id}>
                  {GPU_ARCH[id].label} · {GPU_ARCH[id].processNm} nm · PHY {GPU_ARCH[id].ioGen}
                </option>
              ))}
            </select>
          </label>
          <Slider label="Shaders" min={128} max={32768} step={64} value={config.gpu.shaders} unit="" onChange={(shaders) => edit({ gpu: { shaders } })} />
          <Slider label="Tensor cores" min={0} max={18432} step={8} value={config.gpu.tensors} unit="" onChange={(tensors) => edit({ gpu: { tensors } })} />
          <Slider label="Clock" min={GPU_ARCH[config.gpu.arch].fMinHz / 1e9} max={3.2} step={0.05} value={config.gpu.ghz} unit="GHz" digits={2} onChange={(ghz) => edit({ gpu: { ghz } })} />
          <div className="seg" role="group" aria-label="Precision">
            {PRECISIONS.map((format) => (
              <button key={format} type="button" className={config.gpu.format === format ? "is-on" : ""} aria-pressed={config.gpu.format === format} onClick={() => edit({ gpu: { format } })}>
                {FORMAT_LABEL[format]}
              </button>
            ))}
          </div>
          <Slider label="Load" min={0.05} max={1} step={0.01} value={config.gpu.load} unit="" digits={2} onChange={(load) => edit({ gpu: { load } })} />
          <label>
            Cooler
            <select value={config.gpuCooler} onChange={(event) => edit({ gpuCooler: event.target.value as CoolerId })}>
              {COOLER_IDS.map((id) => (
                <option key={id} value={id}>
                  {COOLERS[id].label}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset className={selected === "dram" ? "is-on" : ""} onClick={() => setSelected("dram")} onFocus={() => setSelected("dram")}>
          <legend>CPU memory</legend>
          <div className="seg" role="group" aria-label="DRAM generation">
            {DRAM_KINDS.map((kind) => (
              <button key={kind} type="button" className={config.dram.kind === kind ? "is-on" : ""} aria-pressed={config.dram.kind === kind} onClick={() => edit({ dram: { kind: kind as DramKind } })}>
                {DRAM_SPEC[kind].label}
              </button>
            ))}
          </div>
          <p className="hint">{DRAM_SPEC[config.dram.kind].note}</p>
          <Slider label="Capacity" min={1} max={2048} step={1} value={config.dram.gb} unit="GB" onChange={(gb) => edit({ dram: { gb } })} />
          <Slider
            label="Data rate"
            min={DRAM_SPEC[config.dram.kind].rateMin}
            max={DRAM_SPEC[config.dram.kind].rateMax}
            step={100}
            value={config.dram.megaTransfers}
            unit="MT/s"
            onChange={(megaTransfers) => edit({ dram: { megaTransfers } })}
          />
          <p className="hint">
            {report.dram.channels} × 64-bit · CK {mhz(report.dram.clockHz)} MHz · {DRAM_SPEC[config.dram.kind].vdd} V
          </p>
        </fieldset>

        <fieldset className={selected === "vram" ? "is-on" : ""} onClick={() => setSelected("vram")} onFocus={() => setSelected("vram")}>
          <legend>GPU memory</legend>
          <div className="seg" role="group" aria-label="VRAM type">
            {VRAM_KINDS.map((kind) => (
              <button key={kind} type="button" className={config.vram.kind === kind ? "is-on" : ""} aria-pressed={config.vram.kind === kind} onClick={() => edit({ vram: { kind: kind as VramKind } })}>
                {VRAM_SPEC[kind].label}
              </button>
            ))}
          </div>
          <p className="hint">{VRAM_SPEC[config.vram.kind].note}</p>
          <label className="check">
            <input type="checkbox" checked={config.forceVram} onChange={(event) => edit({ forceVram: event.target.checked })} />
            Force onto this GPU PHY
          </label>
          <Slider label="Capacity" min={0.5} max={256} step={0.5} digits={Number.isInteger(config.vram.gb) ? 0 : 1} value={config.vram.gb} unit="GB" onChange={(gb) => edit({ vram: { gb } })} />
          <Slider
            label="Data rate"
            min={VRAM_SPEC[config.vram.kind].rateMin}
            max={VRAM_SPEC[config.vram.kind].rateMax}
            step={100}
            value={config.vram.megaTransfers}
            unit="MT/s"
            onChange={(megaTransfers) => edit({ vram: { megaTransfers } })}
          />
          {config.vram.kind === "hbm" ? (
            <Slider label="Stacks" min={1} max={8} step={1} value={config.vram.stacks} unit="× 1024-bit" onChange={(stacks) => edit({ vram: { stacks } })} />
          ) : (
            <label>
              Bus
              <select value={config.vram.busBits} onChange={(event) => edit({ vram: { busBits: Number(event.target.value) } })}>
                {GDDR_BUS_BITS.map((bits) => (
                  <option key={bits} value={bits}>
                    {bits}-bit
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
      </section>

      <footer className={`fabric-status ${report.faults.length > 0 ? "is-fault" : ""}`}>
        <span>{report.link.reason}</span>
        <span>{report.optical.reason}</span>
        {report.notes.length > 0 ? <span>{report.notes.join(" ")}</span> : null}
      </footer>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announced}
      </p>
    </main>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  unit,
  digits = 0,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit: string;
  digits?: number;
  onChange: (value: number) => void;
}) {
  const shown = digits > 0 ? value.toFixed(digits) : String(Math.round(value));
  return (
    <label className="slider">
      <span>
        {label}
        <b>
          {shown} {unit}
        </b>
      </span>
      <input
        className="dial"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
