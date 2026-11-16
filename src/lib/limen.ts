/**
 * LIMEN electrical and optical model, in one file.
 *
 * The fabric is the x16 copper link, the chipset, the CPU, the GPU, DRAM, and VRAM.
 * The optical link is a Mach-Zehnder modulator, a grating, a polymer waveguide, two SiN rings, and an MZI.
 * Copper loss, the SiN ring cascade, the eye, and the length where optics beat copper
 * follow the Phase 5 NumPy model: skin effect, dielectric absorption, and the
 * grating -> waveguide -> two rings -> MZI cascade.
 * Die width, height, and area are reported in nanometres as well as millimetres.
 */

type LaminateName = "fr4" | "megtron";
export type ModFormat = "ook" | "pam4";

type Laminate = {
  er: number;
  tand: number;
  roughM: number;
};

export type Eye = {
  q: number;
  ber: number;
  wave: Float64Array;
  symbols: Float64Array;
  ilDb: number;
};

export type LinkRow = {
  medium: "copper" | "optical";
  lengthCm: number;
  q: number;
  ber: number;
  ilDb: number;
  energyPj: number;
  latencyPs: number;
};

const C = 299_792_458;
const MU0 = 4e-7 * Math.PI;
const SIGMA = 5.8e7;
const Z0 = 85;
const TRACE_W = 200e-6;
const TRACE_T = 35e-6;
const VPPD = 0.8;
const T_RETIMER = 1e-9;
const RESP = 1;
const DARK = 5e-9;
const RIN = 10 ** (-145 / 10);
const TIA_OHM = 400;
const K_B = 1.380649e-23;
const Q_E = 1.602176634e-19;
/**
 * PRBS-15 starts from register 1, so its first 128 PAM4 symbols hold no -1 level at all
 * and the eye reads Q = 0. A PAM4 record needs this many symbols for every level to
 * appear often enough to measure.
 */
const PAM4_MIN_SYMBOLS = 256;

/**
 * The assumed constants, kept in one place so the sensitivity view can move them. Each is a
 * representative value, not a measurement. `withAssumptions` scales them for the length of one
 * call and restores them afterwards, so normal use always sees scale 1.
 */
export const ASSUMPTION_KEYS = [
  "phyFixedShare",
  "opticalFixtureShare",
  "rxBwFrac",
  "launchW",
  "laserMaxW",
  "tiaJ",
  "laserWpe",
  "fixtureLoss",
  "rxNoise",
  "copperXtalk",
] as const;
export type AssumptionKey = (typeof ASSUMPTION_KEYS)[number];

export type AssumptionInfo = {
  label: string;
  /** Base value in the unit named below. */
  value: number;
  unit: string;
  /** What moving it changes. */
  note: string;
};

export const ASSUMPTIONS: Record<AssumptionKey, AssumptionInfo> = {
  phyFixedShare: { label: "PHY fixed energy share", value: 0.25, unit: "", note: "Share of a PHY's energy that stays at zero channel loss: clocking, CDR and the digital core. The rest scales with the loss it equalises" },
  opticalFixtureShare: { label: "Optical hop fixture share", value: 2 / 3, unit: "", note: "Each die keeps a short electrical hop to its optical engine. It sees the two packages but not the x16 connector, a third of the fixture loss" },
  rxBwFrac: { label: "Receiver bandwidth", value: 0.7, unit: "× symbol rate", note: "Photodiode and TIA 3 dB bandwidth as a fraction of the symbol rate, one pole. 0.7 is the usual rule for NRZ" },
  launchW: { label: "Launch power", value: 1, unit: "mW", note: "Optical power leaving the modulator at its on level" },
  laserMaxW: { label: "Laser limit", value: 20, unit: "mW", note: "Most CW power one lane's laser can emit. A lossy or under-driven modulator hits this first" },
  tiaJ: { label: "TIA energy", value: 0.8, unit: "pJ/bit", note: "Receiver amplifier energy per bit" },
  laserWpe: { label: "Laser wall-plug efficiency", value: 0.1, unit: "", note: "Electrical to optical efficiency" },
  fixtureLoss: { label: "Fixture loss", value: 1.25, unit: "dB at 1 GHz", note: "Package, via and connector loss on top of the trace" },
  rxNoise: { label: "Copper receiver noise", value: 8, unit: "nV/√Hz", note: "Input-referred noise density of the copper front end, lumping thermal noise, crosstalk and jitter into one white floor" },
  copperXtalk: { label: "Copper crosstalk", value: -26, unit: "dB", note: "Aggregate neighbour-lane crosstalk relative to the signal. It caps the copper Q near 1/XT however large the swing is" },
};

const SCALE_MIN = 0.1;
const SCALE_MAX = 3;
const scales: Record<AssumptionKey, number> = Object.fromEntries(ASSUMPTION_KEYS.map((key) => [key, 1])) as Record<AssumptionKey, number>;

/** Value of one assumption in the unit the model uses internally (SI). */
const SI: Record<AssumptionKey, number> = {
  phyFixedShare: 0.25,
  opticalFixtureShare: 2 / 3,
  rxBwFrac: 0.7,
  launchW: 1e-3,
  laserMaxW: 20e-3,
  tiaJ: 0.8e-12,
  laserWpe: 0.1,
  fixtureLoss: 1.25,
  rxNoise: 8e-9,
  copperXtalk: -26,
};

function assumed(key: AssumptionKey): number {
  return SI[key] * scales[key];
}

/** The base value of one assumption multiplied by `scale`, in the unit shown to the user. */
export function assumptionValue(key: AssumptionKey, scale = 1): number {
  return ASSUMPTIONS[key].value * scale;
}

function resetModelCaches(): void {
  EYE_CACHE.clear();
  copperRowCache.clear();
  MODULATOR_CACHE.clear();
}

/**
 * Run `fn` with some assumed constants multiplied by the given factors. Factors are clamped to
 * 0.1 to 3, and any key that is missing or not finite stays at 1. The model caches are cleared
 * before and after, because their keys do not include the constants.
 */
export function withAssumptions<T>(factors: Partial<Record<AssumptionKey, number>>, fn: () => T): T {
  const saved = { ...scales };
  for (const key of ASSUMPTION_KEYS) {
    const f = factors[key];
    scales[key] = typeof f === "number" && Number.isFinite(f) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, f)) : 1;
  }
  resetModelCaches();
  try {
    return fn();
  } finally {
    for (const key of ASSUMPTION_KEYS) scales[key] = saved[key];
    resetModelCaches();
  }
}

const POLY = { neff: 1.535, ng: 1.575, wl0: 1.55, alpha: 0.5, bend: 0.02, dndt: -1e-4 };
const SIN = { neff: 1.98, ng: 2.07, wl0: 1.55, alpha: 0.15, dndt: 2.51e-5 };
/** Round-trip phase of the ring at 1550 nm in turns: n_eff L / lambda = 643. */
const RING_ORDER = 643;
/** Circumference [um]. 503 um is a radius of 80.1 um, just above the 80 um bend limit. */
const RING_UM = (RING_ORDER * SIN.wl0) / SIN.neff;
/** Excess loss of one SiN directional coupler [dB], on top of its power split. */
const COUPLER_EXCESS_DB = 0.1;
/**
 * Power coupling of each ring coupler. At 80 um radius the free spectral range is
 * only 2.3 nm, so strong coupling keeps an ~80 GHz passband for a 32 Gbaud eye.
 */
const RING_KAPPA = 0.7;
const RING_LOSS = 0.15;
const MZI_CM = 0.03;
const MZI_KAPPA = 0.5;
const BENDS = 2;
const ETA_O = 0.4;
const ETA_C = 0.5;
const SIGMA_UM = 0.012;
const WL_O = 1.31;
const WL_C = 1.55;

const LAMINATES: Record<LaminateName, Laminate> = {
  fr4: { er: 4.3, tand: 0.02, roughM: 1.8e-6 },
  megtron: { er: 3.62, tand: 0.002, roughM: 0.4e-6 },
};

function dbPerM(neperPerM: number): number {
  return (neperPerM * 20) / Math.log(10);
}

function skinDepth(freqHz: number): number {
  if (freqHz <= 0) return Infinity;
  return 1 / Math.sqrt(Math.PI * freqHz * MU0 * SIGMA);
}

function roughness(freqHz: number, roughM: number): number {
  const delta = skinDepth(freqHz);
  const ratio = (roughM / delta) ** 2;
  return 1 + (2 / Math.PI) * Math.atan(1.4 * ratio);
}

/** α_c + α_d in dB per metre. */
function totalLossDbPerM(freqHz: number, name: LaminateName): number {
  const lam = LAMINATES[name];
  const rDc = 2 / (SIGMA * TRACE_W * TRACE_T);
  const delta = skinDepth(freqHz);
  const rS = freqHz > 0 ? 1 / (SIGMA * delta) : 0;
  const rAc = (2 * rS * roughness(freqHz, lam.roughM)) / TRACE_W;
  const rLoop = Math.sqrt(rDc * rDc + rAc * rAc);
  const conductor = rLoop / (2 * Z0);
  const dielectric = (Math.PI * Math.abs(freqHz) * Math.sqrt(lam.er) * lam.tand) / C;
  return dbPerM(conductor + dielectric);
}

function nyquistLossDb(lengthM: number, symbolRateHz: number, name: LaminateName): number {
  return totalLossDbPerM(0.5 * symbolRateHz, name) * lengthM;
}

/**
 * Raw bit-error target of one lane. PCIe asks about 1e-12 of an NRZ lane. The PAM4 generations
 * run forward error correction and need about 1e-6 before it, so that is the PAM4 target.
 */
function berTarget(fmt: ModFormat): number {
  return fmt === "ook" ? 1e-12 : 1e-6;
}

/** The slowest PCIe generation whose PHY carries `bitRateHz` per lane. */
function phyFor(bitRateHz: number): PcieSpec {
  for (const gen of PCIE_GENS) if (PCIE[gen].gtPerSec * 1e9 >= bitRateHz - 1) return PCIE[gen];
  return PCIE["7.0"];
}

/**
 * PHY energy [J/bit] of one lane that must equalise `ilDb` of loss, FEC included. One bit crosses
 * a transmitter and a receiver, which the table's per-endpoint figure already counts once.
 */
function phyJPerBit(spec: PcieSpec, ilDb: number): number {
  const load = Math.min(Math.max(ilDb, 0) / spec.budgetDb, 1);
  const fixed = Math.min(1, assumed("phyFixedShare"));
  return spec.serdesJPerBit * (fixed + (1 - fixed) * load) + spec.fecJPerBit;
}

/** Energy of one copper bit [pJ/bit]: the PHY at this loss plus one retimer per extra segment. */
function copperEnergyPj(spec: PcieSpec, ilDb: number, retimerCount: number): number {
  return (phyJPerBit(spec, ilDb / (retimerCount + 1)) + retimerCount * spec.retimerJPerBit) * 1e12;
}

function copperLatencyPs(lengthM: number, symbolRateHz: number, name: LaminateName, retimerCount: number): number {
  const flight = (lengthM * Math.sqrt(LAMINATES[name].er)) / C;
  return (flight + 4 / symbolRateHz + retimerCount * T_RETIMER) * 1e12;
}

/**
 * Energy of one optical bit [pJ/bit]: the lane's short electrical PHY hop, the modulator's
 * C·V²/4 drive, the TIA, and the laser share. The laser is sized so the modulator launches
 * the launch power at its on level, so a lossy or under-driven modulator costs wall-plug watts
 * (P_laser / WPE per lane, not divided by the lane count) before it costs eye height.
 */
function opticalEnergyPj(bitRateHz: number, mod: ModulatorState, spec: PcieSpec): number {
  return (opticalPhyJPerBit(spec) + mod.driveJ + assumed("tiaJ") + mod.pLaserW / assumed("laserWpe") / bitRateHz) * 1e12;
}

/** PHY energy of the optical lane's die-to-engine electrical hop [J/bit]. */
function opticalPhyJPerBit(spec: PcieSpec): number {
  return phyJPerBit(spec, Math.min(1, assumed("opticalFixtureShare")) * fixtureLossDb(spec.nyquistHz));
}

function opticalLatencyPs(lengthM: number, symbolRateHz: number): number {
  return (lengthM * POLY.ng / C + 4 / symbolRateHz) * 1e12;
}

function resonanceShiftUm(riseK: number): number {
  return (1.55 * SIN.dndt * riseK) / SIN.ng;
}

const RING_LAP = 10 ** (-(RING_LOSS * RING_UM * 1e-4) / 20);
const COUPLER_ETA = 10 ** (-COUPLER_EXCESS_DB / 10);
const RING_SELF2 = (1 - RING_KAPPA) * COUPLER_ETA;
const RING_CROSS2 = RING_KAPPA * COUPLER_ETA;
const RING_SQRT_LAP = Math.sqrt(RING_LAP);
const MZI_SCALE = Math.sqrt(MZI_KAPPA * (1 - MZI_KAPPA));

type Cx = { re: number; im: number };

function indexAt(wl: number, neff: number, ng: number, wl0: number, riseK: number, dndt: number): number {
  const hot = neff + dndt * riseK;
  return hot - ((wl - wl0) * (ng - hot)) / wl0;
}

function grating(wl: number): number {
  const o = (wl - WL_O) / SIGMA_UM;
  const c = (wl - WL_C) / SIGMA_UM;
  const eta = ETA_O * Math.exp(-0.5 * o * o) + ETA_C * Math.exp(-0.5 * c * c);
  return Math.sqrt(eta < 1 ? eta : 1);
}

/** Polymer or SiN section. `bendLoss` is dB per bend; pass 0 for a straight arm. */
function writeGuide(
  wl: number,
  lengthCm: number,
  bends: number,
  neff: number,
  ng: number,
  wl0: number,
  alpha0: number,
  bendLoss: number,
  dndt: number,
  riseK: number,
  out: Cx,
): void {
  const n = indexAt(wl, neff, ng, wl0, riseK, dndt);
  const alpha = alpha0 * (wl0 / wl) * (wl0 / wl);
  const amp = 10 ** (-(alpha * lengthCm + bendLoss * bends) / 20);
  const phase = (2 * Math.PI * n * (lengthCm * 1e4)) / wl;
  out.re = amp * Math.cos(phase);
  out.im = amp * Math.sin(phase);
}

function writeRing(wl: number, riseK: number, out: Cx): void {
  const n = indexAt(wl, SIN.neff, SIN.ng, SIN.wl0, riseK, SIN.dndt);
  const phase = (2 * Math.PI * n * RING_UM) / wl;
  const c = Math.cos(phase);
  const s = Math.sin(phase);
  const denRe = 1 - RING_SELF2 * RING_LAP * c;
  const denIm = -RING_SELF2 * RING_LAP * s;
  const den = denRe * denRe + denIm * denIm;
  const halfRe = Math.cos(phase / 2);
  const halfIm = Math.sin(phase / 2);
  const numRe = -RING_CROSS2 * RING_SQRT_LAP * halfRe;
  const numIm = -RING_CROSS2 * RING_SQRT_LAP * halfIm;
  out.re = (numRe * denRe + numIm * denIm) / den;
  out.im = (numIm * denRe - numRe * denIm) / den;
}

/**
 * Grating, polymer, two identical rings, then the MZI.
 * `straight` receives the bend-free polymer phasor used to strip flight phase.
 * Both outputs are written in place so the eye loop does not allocate.
 */
function writeLink(
  wl: number,
  lengthCm: number,
  riseWg: number,
  riseRing: number,
  riseHot: number,
  riseCold: number,
  link: Cx,
  straight: Cx,
): void {
  const g = grating(wl);
  const nPoly = indexAt(wl, POLY.neff, POLY.ng, POLY.wl0, riseWg, POLY.dndt);
  const alpha = POLY.alpha * (POLY.wl0 / wl) * (POLY.wl0 / wl);
  const phase = (2 * Math.PI * nPoly * (lengthCm * 1e4)) / wl;
  const cosP = Math.cos(phase);
  const sinP = Math.sin(phase);
  const ampBend = 10 ** (-(alpha * lengthCm + POLY.bend * BENDS) / 20);
  const guideRe = ampBend * cosP;
  const guideIm = ampBend * sinP;
  const ampStraight = 10 ** (-(alpha * lengthCm) / 20);
  straight.re = ampStraight * cosP;
  straight.im = ampStraight * sinP;

  writeRing(wl, riseRing, link);
  const dRe = link.re;
  const dIm = link.im;

  writeGuide(wl, MZI_CM, 0, SIN.neff, SIN.ng, SIN.wl0, SIN.alpha, 0, SIN.dndt, riseHot, link);
  const hotRe = link.re;
  const hotIm = link.im;
  writeGuide(wl, MZI_CM, 0, SIN.neff, SIN.ng, SIN.wl0, SIN.alpha, 0, SIN.dndt, riseCold, link);
  const mziRe = -MZI_SCALE * (hotIm + link.im);
  const mziIm = MZI_SCALE * (hotRe + link.re);

  let re = g * guideRe;
  let im = g * guideIm;
  let nr = re * dRe - im * dIm;
  let ni = re * dIm + im * dRe;
  re = nr * dRe - ni * dIm;
  im = nr * dIm + ni * dRe;
  nr = re * mziRe - im * mziIm;
  ni = re * mziIm + im * mziRe;
  link.re = nr * g;
  link.im = ni * g;
}

/** Full-link field at one wavelength. */
function linkAt(
  wlUm: number,
  lengthCm: number,
  riseWg: number,
  riseRing: number,
  riseHot: number,
  riseCold: number,
): { re: number; im: number } {
  const link = { re: 0, im: 0 };
  writeLink(wlUm, lengthCm, riseWg, riseRing, riseHot, riseCold, link, { re: 0, im: 0 });
  return link;
}

function linkIlDb(
  wlUm: number,
  lengthCm: number,
  riseWg: number,
  riseRing: number,
  riseHot: number,
  riseCold: number,
): number {
  const s = linkAt(wlUm, lengthCm, riseWg, riseRing, riseHot, riseCold);
  const power = Math.max(s.re * s.re + s.im * s.im, 1e-30);
  return -10 * Math.log10(power);
}

function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j + half] = re[i + j] - vRe;
        im[i + j + half] = im[i + j] - vIm;
        re[i + j] += vRe;
        im[i + j] += vIm;
        const next = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = next;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function fftfreq(n: number, sampleRate: number): Float64Array {
  const out = new Float64Array(n);
  const half = n >> 1;
  for (let i = 0; i < n; i++) out[i] = (i <= half ? i : i - n) * (sampleRate / n);
  return out;
}

function prbs(nBits: number): Int8Array {
  const bits = new Int8Array(nBits);
  let register = 1;
  const mask = (1 << 14) | (1 << 13);
  for (let i = 0; i < nBits; i++) {
    bits[i] = (register >> 14) & 1;
    let folded = register & mask;
    let feedback = 0;
    while (folded) {
      feedback ^= folded & 1;
      folded >>= 1;
    }
    register = ((register << 1) | feedback) & 0x7fff;
  }
  return bits;
}

function symbolsOf(fmt: ModFormat, nSymbols: number): Float64Array {
  const bits = prbs(nSymbols * (fmt === "ook" ? 1 : 2));
  const out = new Float64Array(nSymbols);
  if (fmt === "ook") {
    for (let i = 0; i < nSymbols; i++) out[i] = bits[i];
    return out;
  }
  const table = [-3, -1, 3, 1];
  for (let i = 0; i < nSymbols; i++) out[i] = table[bits[2 * i] * 2 + bits[2 * i + 1]];
  return out;
}

function raisedCosine(sps: number): Float64Array {
  const half = 4 * sps;
  const taps = new Float64Array(2 * half + 1);
  const alpha = 0.35;
  for (let i = 0; i < taps.length; i++) {
    const t = (i - half) / sps;
    if (Math.abs(t) < 1e-12) {
      taps[i] = 1;
      continue;
    }
    const denom = 1 - (2 * alpha * t) ** 2;
    if (Math.abs(denom) < 1e-8) {
      taps[i] = (alpha / 2) * Math.sin(Math.PI / (2 * alpha));
      continue;
    }
    const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
    taps[i] = (sinc * Math.cos(Math.PI * alpha * t)) / denom;
  }
  const center = taps[half];
  for (let i = 0; i < taps.length; i++) taps[i] /= center;
  return taps;
}

const TAP_CACHE = new Map<number, Float64Array>();

function shape(symbols: Float64Array, sps: number): Float64Array {
  let taps = TAP_CACHE.get(sps);
  if (!taps) {
    taps = raisedCosine(sps);
    TAP_CACHE.set(sps, taps);
  }
  const expanded = new Float64Array(symbols.length * sps);
  for (let i = 0; i < symbols.length; i++) expanded[i * sps] = symbols[i];
  const full = new Float64Array(expanded.length + taps.length - 1);
  for (let i = 0; i < expanded.length; i++) {
    if (expanded[i] === 0) continue;
    for (let j = 0; j < taps.length; j++) full[i + j] += expanded[i] * taps[j];
  }
  return full.subarray(taps.length >> 1, (taps.length >> 1) + expanded.length);
}

function stripDelay(re: Float64Array, im: Float64Array, freq: Float64Array): void {
  if (freq[1] === 0) return;
  const crossRe = re[1] * re[0] + im[1] * im[0];
  const crossIm = im[1] * re[0] - re[1] * im[0];
  const slope = Math.atan2(crossIm, crossRe) / freq[1];
  for (let i = 0; i < re.length; i++) {
    const ang = -freq[i] * slope;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const nr = re[i] * c - im[i] * s;
    im[i] = re[i] * s + im[i] * c;
    re[i] = nr;
  }
}

function berFromQ(q: number, levels: number): number {
  const bits = Math.log2(levels);
  const z = Math.max(q, 0) / Math.SQRT2;
  // Abramowitz-style erfc for a tail. Accurate enough for the displayed BER.
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = z > 0 ? poly * Math.exp(-z * z) : 2 - poly * Math.exp(-z * z);
  return Math.min(0.5, ((levels - 1) / (levels * bits)) * erfc);
}

function qOf(current: Float64Array, symbols: Float64Array, sps: number): number {
  let pam = false;
  for (let i = 0; i < symbols.length; i++) {
    if (symbols[i] < 0) {
      pam = true;
      break;
    }
  }
  const levels = pam ? [-3, -1, 1, 3] : [0, 1];
  const guard = 16;
  const count = symbols.length;
  const sampled = new Float64Array(count);
  const used = new Float64Array(count);
  let best = 0;
  for (let shift = -1; shift <= 1; shift++) {
    for (let offset = 0; offset < sps; offset++) {
      let nUsed = 0;
      for (let i = 0; i < count; i++) {
        const src = i + shift;
        if (src < 0 || src >= count) continue;
        sampled[nUsed] = current[offset + src * sps];
        used[nUsed] = symbols[i];
        nUsed++;
      }
      if (nUsed <= 2 * guard + 8) continue;
      const means: number[] = [];
      const sigmas: number[] = [];
      let ok = true;
      for (let level = 0; level < levels.length; level++) {
        const target = levels[level];
        let sum = 0;
        let sum2 = 0;
        let n = 0;
        for (let i = guard; i < nUsed - guard; i++) {
          if (Math.abs(used[i] - target) > 1e-6) continue;
          const sample = sampled[i];
          sum += sample;
          sum2 += sample * sample;
          n++;
        }
        if (n < 8) {
          ok = false;
          break;
        }
        const mean = sum / n;
        means.push(mean);
        sigmas.push(Math.max(Math.sqrt(Math.max(sum2 / n - mean * mean, 0)), 1e-18));
      }
      if (!ok) continue;
      let q = Infinity;
      for (let i = 0; i < means.length - 1; i++) {
        q = Math.min(q, (means[i + 1] - means[i]) / (sigmas[i + 1] + sigmas[i]));
      }
      if (q > best) best = q;
    }
  }
  return best;
}

export type Rises = { wg: number; ring: number; hot: number; cold: number; tiaC: number };

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

const SHAPE_CACHE = new Map<string, { symbols: Float64Array; shaped: Float64Array }>();

function cachedTrain(fmt: ModFormat, nSymbols: number, sps: number): { symbols: Float64Array; shaped: Float64Array } {
  const key = `${fmt}|${nSymbols}|${sps}`;
  const hit = SHAPE_CACHE.get(key);
  if (hit) return hit;
  const symbols = symbolsOf(fmt, nSymbols);
  const view = shape(symbols, sps);
  const shaped = new Float64Array(view.length);
  shaped.set(view);
  const train = { symbols, shaped };
  SHAPE_CACHE.set(key, train);
  return train;
}

/** Record length actually simulated: PAM4 is never shorter than `PAM4_MIN_SYMBOLS`. */
function recordSymbols(fmt: ModFormat, requested: number): number {
  return fmt === "pam4" ? Math.max(requested, PAM4_MIN_SYMBOLS) : requested;
}

const EYE_CACHE = new Map<string, Eye>();
const EYE_CACHE_MAX = 8;

export function simulateOptical(
  lengthCm: number,
  bitRateHz: number,
  fmt: ModFormat,
  rises: Rises,
  trackLaser: boolean,
  modulator: ModulatorSpec,
  requestedSymbols = 256,
  sps = 8,
): Eye {
  const nSymbols = recordSymbols(fmt, requestedSymbols);
  const mod = modulatorState(modulator);
  const key = `${lengthCm}|${bitRateHz}|${fmt}|${rises.wg}|${rises.ring}|${rises.hot}|${rises.cold}|${rises.tiaC}|${trackLaser ? 1 : 0}|${mod.key}|${nSymbols}|${sps}`;
  const hit = EYE_CACHE.get(key);
  if (hit) {
    EYE_CACHE.delete(key);
    EYE_CACHE.set(key, hit);
    return hit;
  }
  const train = cachedTrain(fmt, nSymbols, sps);
  const eye = simulateOpticalClean(lengthCm, bitRateHz, fmt, rises, trackLaser, mod, sps, train.symbols, train.shaped);
  EYE_CACHE.set(key, eye);
  if (EYE_CACHE.size > EYE_CACHE_MAX) {
    const oldest = EYE_CACHE.keys().next().value;
    if (oldest !== undefined) EYE_CACHE.delete(oldest);
  }
  return eye;
}

/**
 * Noiseless detected power [W] of the shaped drive after the link, one sample per `shaped` entry.
 *
 * The drive is the symbol train as a fraction of the swing (-0.5 to +0.5). It goes through the
 * modulator's travelling-wave bandwidth (one pole), then the push-pull Mach-Zehnder at quadrature:
 * P = P_laser · T · (1 + (1 - ε) · sin(π · V / Vπ)) / 2, with V = swing · drive.
 */
function opticalPower(
  lengthCm: number,
  bitRateHz: number,
  fmt: ModFormat,
  rises: Rises,
  trackLaser: boolean,
  mod: ModulatorState,
  sps: number,
  shaped: Float64Array,
): { power: Float64Array; symbolRate: number; laser: number } {
  const low = fmt === "ook" ? 0 : -3;
  const high = fmt === "ook" ? 1 : 3;
  const bits = fmt === "ook" ? 1 : 2;
  const symbolRate = bitRateHz / bits;
  const n = nextPow2(shaped.length);
  const freq = fftfreq(n, symbolRate * sps);

  const dre = new Float64Array(n);
  const dim = new Float64Array(n);
  for (let i = 0; i < shaped.length; i++) dre[i] = Math.min(1, Math.max(0, (shaped[i] - low) / (high - low))) - 0.5;
  fft(dre, dim, false);
  for (let i = 0; i < n; i++) {
    const r = freq[i] / mod.bandwidthHz;
    const a = 1 / (1 + r * r);
    const x = dre[i];
    const y = dim[i];
    dre[i] = a * (x + y * r);
    dim[i] = a * (y - x * r);
  }
  fft(dre, dim, true);

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const peak = mod.pLaserW * mod.transmission;
  for (let i = 0; i < shaped.length; i++) {
    const phase = (Math.PI * mod.swingV * dre[i]) / mod.vpiV;
    re[i] = Math.sqrt(Math.max(0, (peak * (1 + (1 - mod.eps) * Math.sin(phase))) / 2));
  }
  fft(re, im, false);

  const laser = 1.55 + (trackLaser ? resonanceShiftUm(rises.ring) : 0);
  const gre = new Float64Array(n);
  const gim = new Float64Array(n);
  const link = { re: 0, im: 0 };
  const straight = { re: 0, im: 0 };
  for (let i = 0; i < n; i++) {
    const wl = (C / (C / (laser * 1e-6) + freq[i])) * 1e6;
    writeLink(wl, lengthCm, rises.wg, rises.ring, rises.hot, rises.cold, link, straight);
    const gMag = Math.hypot(straight.re, straight.im) || 1;
    gre[i] = (link.re * straight.re + link.im * straight.im) / gMag;
    gim[i] = (link.im * straight.re - link.re * straight.im) / gMag;
  }
  stripDelay(gre, gim, freq);
  for (let i = 0; i < n; i++) {
    const nr = re[i] * gre[i] - im[i] * gim[i];
    im[i] = re[i] * gim[i] + im[i] * gre[i];
    re[i] = nr;
  }
  fft(re, im, true);
  const power = new Float64Array(shaped.length);
  for (let i = 0; i < power.length; i++) power[i] = re[i] * re[i] + im[i] * im[i];
  return { power, symbolRate, laser };
}

function simulateOpticalClean(
  lengthCm: number,
  bitRateHz: number,
  fmt: ModFormat,
  rises: Rises,
  trackLaser: boolean,
  mod: ModulatorState,
  sps: number,
  symbols: Float64Array,
  shaped: Float64Array,
): Eye {
  const { power, symbolRate, laser } = opticalPower(lengthCm, bitRateHz, fmt, rises, trackLaser, mod, sps, shaped);
  const current = addOpticalNoise(power, symbolRate, rises.tiaC, sps);
  const q = qOf(current, symbols, sps);
  const il = linkIlDb(laser, lengthCm, rises.wg, rises.ring, rises.hot, rises.cold);
  return { q, ber: berFromQ(q, fmt === "ook" ? 2 : 4), wave: current, symbols, ilDb: il };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Photocurrent of `power` after the receiver's one-pole response, plus its noise. The record
 * repeats, so the filter runs twice and the second pass is kept: it starts from steady state.
 */
function addOpticalNoise(power: Float64Array, symbolRate: number, tempC: number, sps: number): Float64Array {
  const f3 = assumed("rxBwFrac") * symbolRate;
  const bandwidth = (Math.PI / 2) * f3;
  const a = 1 - Math.exp((-2 * Math.PI * f3) / (symbolRate * sps));
  const detected = new Float64Array(power.length);
  let y = power.length > 0 ? power[0] : 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < power.length; i++) {
      y += a * (power[i] - y);
      detected[i] = y;
    }
  }
  const out = new Float64Array(power.length);
  const rand = mulberry32(1);
  const thermal = (4 * K_B * (tempC + 273.15) * bandwidth) / TIA_OHM;
  for (let i = 0; i < power.length; i++) {
    const primary = RESP * detected[i] + DARK;
    const shot = 2 * Q_E * primary * bandwidth;
    const rin = RIN * (RESP * detected[i]) ** 2 * bandwidth;
    out[i] = primary + gaussian(rand) * Math.sqrt(shot + rin + thermal);
  }
  return out;
}

function formatFor(bitRateHz: number): ModFormat {
  return bitRateHz <= 32e9 + 1 ? "ook" : "pam4";
}

/** Smallest Q whose BER is `ber` (inverse of `berFromQ`), capped at 40. */
function qFromBer(ber: number, levels: number): number {
  if (ber >= 0.5) return 0;
  if (ber <= berFromQ(40, levels)) return 40;
  let lo = 0;
  let hi = 40;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (berFromQ(mid, levels) > ber) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Q of one copper hop of `hopM` metres plus `fixtureShare` of the package and connector loss.
 * The loss of `totalLossDbPerM(f) · hopM + fixtureShare · fixtureLossDb(f)` is made causal
 * with a minimum-phase (cepstral) response, the receiver applies the Wiener (MMSE)
 * linear equaliser for white input noise of the copper receiver floor (`rxNoise`), and Q is read from the
 * equalised eye exactly as for the optical link, so ISI left over is counted. One
 * aggressor (the same data run backwards, which is a different bit sequence) is coupled
 * in at the crosstalk level (`copperXtalk`) through the same channel and equaliser.
 */
function copperHopQ(
  hopM: number,
  fixtureShare: number,
  symbolRate: number,
  name: LaminateName,
  fmt: ModFormat,
  symbols: Float64Array,
  shaped: Float64Array,
  sps: number,
): number {
  const low = fmt === "ook" ? 0 : -3;
  const high = fmt === "ook" ? 1 : 3;
  const n = 2 * nextPow2(shaped.length);
  const sampleRate = symbolRate * sps;
  const freq = fftfreq(n, sampleRate);

  // Minimum-phase H from |H| = 10^(-loss L / 20): fold the real cepstrum.
  const cre = new Float64Array(n);
  const cim = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = Math.abs(freq[i]);
    cre[i] = (-(totalLossDbPerM(f, name) * hopM + fixtureShare * fixtureLossDb(f)) * Math.LN10) / 20;
  }
  fft(cre, cim, true);
  const half = n >> 1;
  for (let i = 1; i < half; i++) cre[i] *= 2;
  for (let i = half + 1; i < n; i++) cre[i] = 0;
  cim.fill(0);
  fft(cre, cim, false);
  const hre = new Float64Array(n);
  const him = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const mag = Math.exp(cre[i]);
    hre[i] = mag * Math.cos(cim[i]);
    him[i] = mag * Math.sin(cim[i]);
  }

  // Transmit spectrum.
  const xre = new Float64Array(n);
  const xim = new Float64Array(n);
  for (let i = 0; i < shaped.length; i++) xre[i] = (VPPD * (shaped[i] - 0.5 * (low + high))) / (high - low);
  fft(xre, xim, false);

  // Wiener equaliser W = H* S / (|H|^2 S + N), S smoothed over +-4 bins.
  const sigma2 = assumed("rxNoise") ** 2 * 0.5 * sampleRate;
  const noiseBin = n * sigma2;
  const power = new Float64Array(n);
  for (let i = 0; i < n; i++) power[i] = xre[i] * xre[i] + xim[i] * xim[i];
  const wre = new Float64Array(n);
  const wim = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let d = -4; d <= 4; d++) sum += power[(i + d + n) % n];
    const s = sum / 9;
    const h2 = hre[i] * hre[i] + him[i] * him[i];
    const gain = s / (h2 * s + noiseBin);
    wre[i] = hre[i] * gain;
    wim[i] = -him[i] * gain;
  }

  // Signal path: equalised response with the bulk delay removed.
  const tre = new Float64Array(n);
  const tim = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    tre[i] = wre[i] * hre[i] - wim[i] * him[i];
    tim[i] = wre[i] * him[i] + wim[i] * hre[i];
  }
  stripDelay(tre, tim, freq);
  const yre = new Float64Array(n);
  const yim = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    yre[i] = xre[i] * tre[i] - xim[i] * tim[i];
    yim[i] = xre[i] * tim[i] + xim[i] * tre[i];
  }
  fft(yre, yim, true);

  // Noise path: white noise through W.
  const rand = mulberry32(1);
  const sigma = Math.sqrt(sigma2);
  const nre = new Float64Array(n);
  const nim = new Float64Array(n);
  for (let i = 0; i < n; i++) nre[i] = sigma * gaussian(rand);
  fft(nre, nim, false);
  for (let i = 0; i < n; i++) {
    const r = nre[i] * wre[i] - nim[i] * wim[i];
    nim[i] = nre[i] * wim[i] + nim[i] * wre[i];
    nre[i] = r;
  }
  fft(nre, nim, true);

  // Aggressor path: reversed data through the same equalised response.
  const are = new Float64Array(n);
  const aim = new Float64Array(n);
  const last = shaped.length - 1;
  for (let i = 0; i <= last; i++) are[i] = (VPPD * (shaped[last - i] - 0.5 * (low + high))) / (high - low);
  fft(are, aim, false);
  for (let i = 0; i < n; i++) {
    const r = are[i] * tre[i] - aim[i] * tim[i];
    aim[i] = are[i] * tim[i] + aim[i] * tre[i];
    are[i] = r;
  }
  fft(are, aim, true);

  const xt = 10 ** (assumed("copperXtalk") / 20);
  const wave = new Float64Array(shaped.length);
  for (let i = 0; i < wave.length; i++) wave[i] = yre[i] + nre[i] + xt * are[i];
  return qOf(wave, symbols, sps);
}

/**
 * Copper Q over `lengthM` metres in `hops` segments. A channel over the generation's loss limit
 * is cut into equal hops, each short enough for the limit, with the fixture loss shared between
 * them. A retimer regenerates every hop, so hop bit errors add up and Q is quoted as the Q
 * that gives the summed BER.
 */
function copperLinkQ(
  lengthM: number,
  hops: number,
  symbolRate: number,
  name: LaminateName,
  fmt: ModFormat,
  symbols: Float64Array,
  shaped: Float64Array,
  sps: number,
): number {
  const levels = fmt === "ook" ? 2 : 4;
  const q = copperHopQ(lengthM / hops, 1 / hops, symbolRate, name, fmt, symbols, shaped, sps);
  if (hops === 1) return q;
  return qFromBer(hops * berFromQ(q, levels), levels);
}

type CopperRow = { ilDb: number; q: number; ber: number; pj: number; latencyPs: number };
const COPPER_LENGTHS_CM = 30; // 2..60 cm in 2 cm steps
const copperRowCache = new Map<string, readonly CopperRow[]>();

/**
 * Copper side of the frontier. It depends on the laminate, rate, format, record and oversampling only,
 * never on the optical rises or the laser tracking, so a slider drag reuses it instead of re-running ~30 FFT solves.
 * The simulation is deterministic (fixed seed), so a cached row is identical to a fresh one.
 */
function copperRows(
  name: LaminateName,
  spec: PcieSpec,
  bitRateHz: number,
  fmt: ModFormat,
  train: { symbols: Float64Array; shaped: Float64Array },
  sps: number,
): readonly CopperRow[] {
  const key = `${name}|${spec.gen}|${bitRateHz}|${fmt}|${train.symbols.length}|${sps}`;
  const hit = copperRowCache.get(key);
  if (hit) return hit;
  const levels = fmt === "ook" ? 2 : 4;
  const symbolRate = bitRateHz / (fmt === "ook" ? 1 : 2);
  const rows: CopperRow[] = [];
  for (let i = 0; i < COPPER_LENGTHS_CM; i++) {
    const lengthM = (2 + 2 * i) / 100;
    const ilDb = nyquistLossDb(lengthM, symbolRate, name) + fixtureLossDb(0.5 * symbolRate);
    const retimerCount = requiredRetimers(ilDb, spec.budgetDb);
    const q = copperLinkQ(lengthM, retimerCount + 1, symbolRate, name, fmt, train.symbols, train.shaped, sps);
    rows.push({
      ilDb,
      q,
      ber: berFromQ(q, levels),
      pj: copperEnergyPj(spec, ilDb, retimerCount),
      latencyPs: copperLatencyPs(lengthM, symbolRate, name, retimerCount),
    });
  }
  if (copperRowCache.size >= 24) copperRowCache.clear();
  copperRowCache.set(key, rows);
  return rows;
}

/**
 * Optical-versus-copper sweep from 2 to 60 cm. Nothing is anchored: every length gets
 * its own optical link (the noiseless power at one length is exact for all lengths,
 * because polymer length only scales the field, so it is rescaled by the loss
 * difference and noise is added again) and its own copper simulation.
 */
export function solveFrontier(
  rises: Rises,
  name: LaminateName,
  bitRateHz: number,
  trackLaser: boolean,
  modulator: ModulatorSpec,
  requestedSymbols = 128,
  sps = 8,
): { rows: LinkRow[]; crossoverCm: number | null } {
  const mod = modulatorState(modulator);
  const fmt = formatFor(bitRateHz);
  const levels = fmt === "ook" ? 2 : 4;
  const bits = fmt === "ook" ? 1 : 2;
  const symbolRate = bitRateHz / bits;
  const train = cachedTrain(fmt, recordSymbols(fmt, requestedSymbols), sps);
  const refCm = 10;
  const spec = phyFor(bitRateHz);
  const target = berTarget(fmt);
  const copper = copperRows(name, spec, bitRateHz, fmt, train, sps);
  const { power, laser } = opticalPower(refCm, bitRateHz, fmt, rises, trackLaser, mod, sps, train.shaped);
  const refIl = linkIlDb(laser, refCm, rises.wg, rises.ring, rises.hot, rises.cold);
  const scaled = new Float64Array(power.length);
  const rows: LinkRow[] = [];
  let crossoverCm: number | null = null;
  for (let lengthCm = 2; lengthCm <= 60; lengthCm += 2) {
    const lengthM = lengthCm / 100;
    const opticalIl = linkIlDb(laser, lengthCm, rises.wg, rises.ring, rises.hot, rises.cold);
    const gain = 10 ** (-(opticalIl - refIl) / 10);
    for (let i = 0; i < power.length; i++) scaled[i] = power[i] * gain;
    const qOpt = qOf(addOpticalNoise(scaled, symbolRate, rises.tiaC, sps), train.symbols, sps);
    const { ilDb: copperIl, q: qCu, ber: copperBer, pj: copperPj, latencyPs: copperLatency } = copper[(lengthCm - 2) / 2];
    const opticalBer = berFromQ(qOpt, levels);
    const opticalPj = opticalEnergyPj(bitRateHz, mod, spec);
    rows.push({
      medium: "optical",
      lengthCm,
      q: qOpt,
      ber: opticalBer,
      ilDb: opticalIl,
      energyPj: opticalPj,
      latencyPs: opticalLatencyPs(lengthM, symbolRate),
    });
    rows.push({
      medium: "copper",
      lengthCm,
      q: qCu,
      ber: copperBer,
      ilDb: copperIl,
      energyPj: copperPj,
      latencyPs: copperLatency,
    });
    const opticalUsable = opticalBer <= target && opticalIl <= OPTICAL_BUDGET_DB;
    if (crossoverCm === null && opticalUsable && (opticalPj <= copperPj || copperBer > target)) {
      crossoverCm = lengthCm;
    }
  }
  return { rows, crossoverCm };
}

/** The raw bit-error target of a lane at this rate, and the Q that reaches it. */
export function linkTarget(bitRateHz: number): { format: ModFormat; ber: number; q: number } {
  const format = formatFor(bitRateHz);
  const ber = berTarget(format);
  const levels = format === "ook" ? 2 : 4;
  let lo = 0;
  let hi = 20;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (berFromQ(mid, levels) > ber) lo = mid;
    else hi = mid;
  }
  return { format, ber, q: (lo + hi) / 2 };
}

/**
 * One board solved end to end: the report, the temperatures the optical path sits at, and the
 * copper-versus-optical sweep for the configured lane. The dashboard and the report export both
 * read this, so they cannot disagree.
 */
export function analyze(input: BenchConfig): {
  report: BenchReport;
  rises: Rises;
  frontier: { rows: LinkRow[]; crossoverCm: number | null };
} {
  const report = evaluate(input);
  const config = report.config;
  const rises: Rises = {
    wg: report.optical.riseWgK,
    ring: report.optical.riseRingK,
    hot: report.optical.riseRingK,
    cold: 1,
    tiaC: config.ambientC + report.optical.riseWgK,
  };
  const track = config.optical.band === "c1550" && config.optical.track;
  const frontier = solveFrontier(rises, report.chipset.laminate, config.optical.gbitPerLane * 1e9, track, modulatorSpec(config.optical));
  return { report, rises, frontier };
}

export function spectrumDb(
  lengthCm: number,
  rises: Rises,
  fromUm = 1.548,
  toUm = 1.553,
  count = 241,
): { wl: number[]; db: number[] } {
  const wl: number[] = [];
  const db: number[] = [];
  for (let i = 0; i < count; i++) {
    const w = fromUm + ((toUm - fromUm) * i) / (count - 1);
    wl.push(w);
    db.push(linkIlDb(w, lengthCm, rises.wg, rises.ring, rises.hot, rises.cold));
  }
  return { wl, db };
}

/** Peak wavelength and the loss at 1550 nm as the ring warms. */
export function driftCurve(lengthCm: number, riseWg: number, riseHot: number, riseCold: number): {
  tempC: number[];
  peakUm: number[];
  il1550: number[];
} {
  const tempC: number[] = [];
  const peakUm: number[] = [];
  const il1550: number[] = [];
  for (let t = 25; t <= 95; t += 5) {
    const rise = t - 25;
    tempC.push(t);
    peakUm.push(1.55 + resonanceShiftUm(rise));
    il1550.push(linkIlDb(1.55, lengthCm, riseWg, rise, riseHot, riseCold));
  }
  return { tempC, peakUm, il1550 };
}

/**
 * On-board optical fabric for LIMEN.
 *
 * The cascade is the grating → polymer waveguide → two SiN rings → MZI
 * from the Phase 5 model. This module places that cascade on the
 * motherboard run between the CPU package and the GPU package and reports
 * every wavelength in nanometres.
 *
 * Ring resonance walk [nm], \(\lambda_0 = 1550\,\mathrm{nm}\):
 * \[
 *   \Delta\lambda = 10^{3}\,\lambda_{\mu\mathrm{m}}\,\frac{1}{n_g}\frac{dn}{dT}\,\Delta T
 * \]
 *
 * Wall-plug of the laser plus the modulator and the TIA [W].
 * Each lane is launched at \(P_L = 1\,\mathrm{mW}\) (the same figure the eye and
 * Q model use), so the laser must emit \(N P_L\) however the beam is split.
 * \(\eta = 0.1\), \(E_m = 0.5\,\mathrm{pJ}\), \(E_{\mathrm{TIA}} = 0.8\,\mathrm{pJ}\),
 * rate \(R\) in [bit/s]:
 * \[
 *   P = N\left[(E_m + E_{\mathrm{TIA}})R + P_L/\eta\right]
 * \]
 */

export type OpticalBand = "c1550" | "o1310";

export const MODULATOR_IDS = ["si", "tfln", "eop"] as const;
export type ModulatorId = (typeof MODULATOR_IDS)[number];

/**
 * Push-pull Mach-Zehnder modulators. The silicon-nitride rings have no useful electro-optic
 * effect (they are tuned by heat), so the transmit modulator is a separate device on the
 * lane. These are representative literature-style figures, not a foundry's process data.
 */
export type ModulatorMaterial = {
  id: ModulatorId;
  label: string;
  /** Phase efficiency V·L for a π difference between the arms [V·cm]. */
  vpiLVcm: number;
  /** Propagation loss inside the modulated section [dB/mm]. */
  lossDbPerMm: number;
  /** Fixed excess loss: splitter, combiner, transitions [dB]. */
  excessDb: number;
  /** Electrode capacitance [pF/mm]. */
  capPfPerMm: number;
  /** Travelling-wave 3 dB bandwidth times length [GHz·mm]. */
  bwGhzMm: number;
  /** Static extinction ratio at full swing [dB]. */
  erMaxDb: number;
  /** Starting section length [mm] and peak-to-peak drive [V] when this material is chosen. */
  lengthMm: number;
  swingV: number;
};

export const MODULATORS: Record<ModulatorId, ModulatorMaterial> = {
  si: { id: "si", label: "Silicon, carrier depletion", vpiLVcm: 2.0, lossDbPerMm: 1.0, excessDb: 1.5, capPfPerMm: 0.35, bwGhzMm: 120, erMaxDb: 25, lengthMm: 3, swingV: 3 },
  tfln: { id: "tfln", label: "Thin-film lithium niobate", vpiLVcm: 2.2, lossDbPerMm: 0.04, excessDb: 1.0, capPfPerMm: 0.15, bwGhzMm: 450, erMaxDb: 30, lengthMm: 5, swingV: 3 },
  eop: { id: "eop", label: "Electro-optic polymer", vpiLVcm: 0.9, lossDbPerMm: 0.15, excessDb: 1.5, capPfPerMm: 0.2, bwGhzMm: 250, erMaxDb: 25, lengthMm: 3, swingV: 2 },
};

export const MODULATOR_LENGTH_MM = { min: 0.5, max: 10 } as const;
export const MODULATOR_SWING_V = { min: 0.5, max: 6 } as const;

export type ModulatorSpec = { id: ModulatorId; lengthMm: number; swingV: number };

export type ModulatorReport = {
  id: ModulatorId;
  label: string;
  lengthMm: number;
  /** Peak-to-peak drive actually applied: the request, capped at Vπ [V]. */
  swingV: number;
  /** True when the requested swing was above Vπ and was capped. */
  swingCapped: boolean;
  vpiV: number;
  /** Extinction ratio at this swing [dB]. */
  erDb: number;
  /** Modulator insertion loss, excess plus length [dB]. */
  ilDb: number;
  bandwidthGhz: number;
  capPf: number;
  /** C·V²/4 drive energy [pJ/bit]. */
  driveEnergyPj: number;
  /** CW laser power one lane needs, or can give [mW]. */
  laserMw: number;
  /** On-level power leaving the modulator [mW]. */
  launchMw: number;
  /** The lane wanted more than the laser can emit, so the launch fell short. */
  laserLimited: boolean;
};

type ModulatorState = {
  key: string;
  report: ModulatorReport;
  vpiV: number;
  swingV: number;
  /** Residual transmission fraction that sets the static extinction. */
  eps: number;
  /** Linear transmission of the excess and length loss. */
  transmission: number;
  bandwidthHz: number;
  pLaserW: number;
  /** Drive energy per bit [J]. */
  driveJ: number;
};

function isModulatorId(value: unknown): value is ModulatorId {
  return typeof value === "string" && (MODULATOR_IDS as readonly string[]).includes(value);
}

const MODULATOR_CACHE = new Map<string, ModulatorState>();

/**
 * Operating point of one lane's modulator.
 *
 * The laser is sized so the on level leaving the modulator is the launch power (`launchW`), up to
 * the laser limit (`laserMaxW`). Driving below Vπ shrinks the swing, not the on level, until the laser runs out.
 */
function modulatorState(spec: ModulatorSpec): ModulatorState {
  const material = MODULATORS[spec.id];
  const lengthMm = clamp(spec.lengthMm, MODULATOR_LENGTH_MM.min, MODULATOR_LENGTH_MM.max);
  const requestedV = clamp(spec.swingV, MODULATOR_SWING_V.min, MODULATOR_SWING_V.max);
  const key = `${spec.id}|${lengthMm}|${requestedV}`;
  const hit = MODULATOR_CACHE.get(key);
  if (hit) return hit;

  const vpiV = material.vpiLVcm / (lengthMm / 10);
  const swingV = Math.min(requestedV, vpiV);
  const ilDb = material.excessDb + material.lossDbPerMm * lengthMm;
  const transmission = 10 ** (-ilDb / 10);
  const eps = 2 / (1 + 10 ** (material.erMaxDb / 10));
  const sine = Math.sin((Math.PI * swingV) / (2 * vpiV));
  const onFactor = (1 + (1 - eps) * sine) / 2;
  const offFactor = (1 - (1 - eps) * sine) / 2;
  const wantedW = assumed("launchW") / (transmission * onFactor);
  const laserMaxW = assumed("laserMaxW");
  const pLaserW = Math.min(wantedW, laserMaxW);
  const capPf = material.capPfPerMm * lengthMm;
  const driveJ = 0.25 * capPf * 1e-12 * swingV * swingV;
  const state: ModulatorState = {
    key,
    vpiV,
    swingV,
    eps,
    transmission,
    bandwidthHz: (material.bwGhzMm * 1e9) / lengthMm,
    pLaserW,
    driveJ,
    report: {
      id: spec.id,
      label: material.label,
      lengthMm,
      swingV,
      swingCapped: requestedV > vpiV,
      vpiV,
      erDb: 10 * Math.log10(onFactor / Math.max(offFactor, 1e-12)),
      ilDb,
      bandwidthGhz: material.bwGhzMm / lengthMm,
      capPf,
      driveEnergyPj: driveJ * 1e12,
      laserMw: pLaserW * 1e3,
      launchMw: pLaserW * transmission * onFactor * 1e3,
      laserLimited: wantedW > laserMaxW,
    },
  };
  if (MODULATOR_CACHE.size > 64) MODULATOR_CACHE.clear();
  MODULATOR_CACHE.set(key, state);
  return state;
}

export type OpticalConfig = {
  enabled: boolean;
  band: OpticalBand;
  /** Parallel polymer waveguides. */
  lanes: number;
  /** Payload rate of one lane [Gbit/s]. */
  gbitPerLane: number;
  /** Lock the C-band laser to the heated ring. O-band cannot track a 1550 nm resonator. */
  track: boolean;
  /** Transmit modulator material, section length [mm] and peak-to-peak drive [V]. */
  modulator: ModulatorId;
  modLengthMm: number;
  modSwingV: number;
};

export function modulatorSpec(config: OpticalConfig): ModulatorSpec {
  return { id: config.modulator, lengthMm: config.modLengthMm, swingV: config.modSwingV };
}

const DEFAULT_OPTICAL: OpticalConfig = {
  enabled: true,
  band: "c1550",
  lanes: 8,
  gbitPerLane: 32,
  track: true,
  modulator: "tfln",
  modLengthMm: MODULATORS.tfln.lengthMm,
  modSwingV: MODULATORS.tfln.swingV,
};

/** On-board mask [dB]. The 10 cm tracked reference sits near 13 dB. */
const OPTICAL_BUDGET_DB = 20;

const REST_C_NM = 1550;
const REST_O_NM = 1310;

export type OpticalReport = {
  enabled: boolean;
  band: OpticalBand;
  lengthCm: number;
  /** Laser wavelength after tracking [nm]. */
  wavelengthNm: number;
  /** SiN ring resonance walk [nm]. Positive is a red shift. */
  shiftNm: number;
  lanes: number;
  gbitPerLane: number;
  format: ModFormat;
  up: boolean;
  reason: string;
  ilDb: number;
  budgetDb: number;
  q: number;
  ber: number;
  /** Energy of one transmitted bit, laser share included [pJ/bit]. */
  energyPj: number;
  /** Flight plus four unit intervals [ps]. */
  latencyPs: number;
  /** Aggregate payload, one direction [B/s]. */
  bytesPerSec: number;
  /** Laser bank plus every modulator and TIA [W]. Zero when the fabric is off. */
  watts: number;
  riseRingK: number;
  riseWgK: number;
  /** Transmit modulator operating point. */
  modulator: ModulatorReport;
  /** One symbol trace, normalised 0–1, for the eye drawing. Empty off the C-band. */
  eye: readonly number[];
};

type OpticalDrive = {
  config: OpticalConfig;
  /** Polymer length, the same run as the copper x16 [cm]. */
  lengthCm: number;
  ambientC: number;
  /** CPU junction [°C]. */
  cpuC: number;
  /** GPU junction [°C]. The rings and the hot MZI arm sit on this tile. */
  gpuC: number;
};

/** Electrical power of N optical lanes [W]. */
function opticalWatts(lanes: number, bitRateHz: number, mod: ModulatorState, spec: PcieSpec): number {
  const n = Math.max(lanes, 0);
  return n * ((opticalPhyJPerBit(spec) + mod.driveJ + assumed("tiaJ")) * bitRateHz + mod.pLaserW / assumed("laserWpe"));
}

function eyeTrace(wave: Float64Array): number[] {
  const want = 72;
  const step = Math.max(1, Math.floor(wave.length / want));
  const raw: number[] = [];
  for (let i = 0; i < wave.length && raw.length < want; i += step) raw.push(wave[i]);
  const lo = raw.reduce((min, value) => Math.min(min, value), Infinity);
  const hi = raw.reduce((max, value) => Math.max(max, value), -Infinity);
  const span = hi - lo;
  if (!(span > 0)) return raw.map(() => 0);
  return raw.map((value) => (value - lo) / span);
}

/**
 * Solve the on-board link at the two package temperatures.
 *
 * The ring and the hot MZI arm take the GPU rise above ambient [K].
 * The cold arm is held 1 K above the board. The polymer takes a quarter
 * of the mean package rise, because it is on the laminate, not the die.
 */
function solveOptical(drive: OpticalDrive): OpticalReport {
  const { config } = drive;
  const cpuRise = Math.max(0, drive.cpuC - drive.ambientC);
  const gpuRise = Math.max(0, drive.gpuC - drive.ambientC);
  const riseRing = gpuRise;
  const riseHot = gpuRise;
  const riseCold = 1;
  const riseWg = 0.25 * ((cpuRise + gpuRise) / 2);
  const shiftNm = resonanceShiftUm(riseRing) * 1e3;
  const restNm = config.band === "c1550" ? REST_C_NM : REST_O_NM;
  const tracked = config.band === "c1550" && config.track;
  const wavelengthNm = tracked ? restNm + shiftNm : restNm;
  const bitRateHz = config.gbitPerLane * 1e9;
  const format = formatFor(bitRateHz);
  const bits = format === "ook" ? 1 : 2;
  const latencyPs = opticalLatencyPs(drive.lengthCm / 100, bitRateHz / bits);
  const bytesPerSec = config.lanes * bitRateHz / 8;
  const mod = modulatorState(modulatorSpec(config));
  const liveWatts = opticalWatts(config.lanes, bitRateHz, mod, phyFor(bitRateHz));
  const watts = config.enabled ? liveWatts : 0;
  const energyPj = config.lanes > 0 && bitRateHz > 0 ? (liveWatts / (config.lanes * bitRateHz)) * 1e12 : 0;

  let q = 0;
  let ber = 1;
  let eye: readonly number[] = [];
  let ilDb: number;
  if (config.enabled && config.band === "c1550") {
    const solved = simulateOptical(
      drive.lengthCm,
      bitRateHz,
      format,
      { wg: riseWg, ring: riseRing, hot: riseHot, cold: riseCold, tiaC: drive.ambientC + riseWg },
      config.track,
      modulatorSpec(config),
      128,
      8,
    );
    q = solved.q;
    ber = solved.ber;
    ilDb = solved.ilDb;
    eye = eyeTrace(solved.wave);
  } else {
    ilDb = linkIlDb(wavelengthNm * 1e-3, drive.lengthCm, riseWg, riseRing, riseHot, riseCold);
  }

  const maskOk = ilDb <= OPTICAL_BUDGET_DB;
  const eyeOk = config.band === "o1310" ? maskOk : ber <= berTarget(format);
  const up = config.enabled && maskOk && eyeOk;
  let reason = "On-board optical fabric is off. The copper x16 is unchanged.";
  if (config.enabled && up && tracked) {
    reason = `C-band ${wavelengthNm.toFixed(2)} nm locked to the ring (+${shiftNm.toFixed(2)} nm). ${ilDb.toFixed(2)} dB on ${drive.lengthCm} cm, Q ${q.toFixed(1)}.`;
  } else if (config.enabled && up) {
    reason = `${config.band === "c1550" ? "C-band" : "O-band"} ${wavelengthNm.toFixed(0)} nm open. ${ilDb.toFixed(2)} dB on ${drive.lengthCm} cm.`;
  } else if (config.enabled && !maskOk) {
    reason = `${wavelengthNm.toFixed(1)} nm did not train. Channel ${ilDb.toFixed(1)} dB, on-board mask ${OPTICAL_BUDGET_DB.toFixed(0)} dB.`;
  } else if (config.enabled && !eyeOk) {
    const m = mod.report;
    reason = `Eye closed at ${wavelengthNm.toFixed(1)} nm. Q ${q.toFixed(2)}, BER ${ber.toExponential(1)}. Insertion loss ${ilDb.toFixed(1)} dB. Modulator ${m.erDb.toFixed(1)} dB extinction, Vπ ${m.vpiV.toFixed(1)} V, ${m.bandwidthGhz.toFixed(0)} GHz${m.laserLimited ? ", laser at its limit" : ""}.`;
  }

  return {
    enabled: config.enabled,
    band: config.band,
    lengthCm: drive.lengthCm,
    wavelengthNm,
    shiftNm,
    lanes: config.lanes,
    gbitPerLane: config.gbitPerLane,
    format,
    up,
    reason,
    ilDb,
    budgetDb: OPTICAL_BUDGET_DB,
    q,
    ber,
    energyPj,
    latencyPs,
    bytesPerSec,
    watts,
    riseRingK: riseRing,
    riseWgK: riseWg,
    modulator: mod.report,
    eye,
  };
}

/**
 * CPU–GPU fabric model: x16 PCIe 3.0–7.0, chipset channel, DRAM, VRAM,
 * and the steady-state watts that become heat.
 *
 * The on-board optical path (grating, polymer, two SiN rings, MZI) is solved
 * beside the copper x16. Die width, height, and area are also reported in
 * nanometres: \(1\,\mathrm{mm} = 10^{6}\,\mathrm{nm}\), \(1\,\mathrm{mm}^{2} = 10^{12}\,\mathrm{nm}^{2}\).
 *
 * PCIe payload, one direction [B/s]:
 * \[ B = N \cdot R_{GT} \cdot 10^{9} \cdot \eta / 8 \]
 *
 * Junction temperature [°C], package power \(P\) in [W], cooler \(R_{\theta}\) in [K/W]:
 * \[ T_j = T_a + P \cdot R_{\theta} \]
 *
 * Steady state conserves energy [W]:
 * \[ Q = P_{cpu} + P_{gpu} + P_{dram} + P_{vram} + P_{pch} + P_{retimer} + P_{fan} \]
 */

export const PCIE_GENS = ["1.0", "2.0", "3.0", "4.0", "5.0", "6.0", "7.0"] as const;
export type PcieGen = (typeof PCIE_GENS)[number];

export const DRAM_KINDS = ["ddr2", "ddr3", "ddr4", "ddr5"] as const;
export type DramKind = (typeof DRAM_KINDS)[number];

export const VRAM_KINDS = ["gddr3", "gddr5", "gddr5x", "gddr6", "gddr6x", "gddr7", "hbm"] as const;
export type VramKind = (typeof VRAM_KINDS)[number];

export const PRECISIONS = ["fp64", "fp32", "tf32", "fp16", "bf16", "fp8", "int8"] as const;
export type Precision = (typeof PRECISIONS)[number];

export const COOLER_IDS = ["air", "aio240", "aio360", "loop"] as const;
export type CoolerId = (typeof COOLER_IDS)[number];

export const GDDR_BUS_BITS = [64, 96, 128, 192, 256, 320, 384, 512] as const;

const CORE_MAX = 256;
export const THREAD_MAX = 512;
const TENSOR_MAX = 18432;
const SHADER_MIN = 128;
const SHADER_MAX = 32768;
const DRAM_MIN_GB = 1;
const VRAM_MIN_GB = 0.5;

type PcieSpec = {
  gen: PcieGen;
  /** Per-lane rate [GT/s]. PAM4 generations count bits, not baud. */
  gtPerSec: number;
  modulation: "nrz" | "pam4";
  /** Payload bits / line bits. 128/130 or FLIT 242/256. */
  payloadRatio: number;
  nyquistHz: number;
  /** Endpoint energy per transmitted bit, TX+RX [J/bit]. */
  serdesJPerBit: number;
  fecJPerBit: number;
  retimerJPerBit: number;
  /** Whole-channel mask [dB]. A retimer starts a new segment. */
  budgetDb: number;
};

const PCIE: Record<PcieGen, PcieSpec> = {
  // Gen 1 and 2 use 8b/10b line coding, so only 80 % of the line rate is payload.
  "1.0": { gen: "1.0", gtPerSec: 2.5, modulation: "nrz", payloadRatio: 8 / 10, nyquistHz: 1.25e9, serdesJPerBit: 40e-12, fecJPerBit: 0, retimerJPerBit: 4e-12, budgetDb: 13 },
  "2.0": { gen: "2.0", gtPerSec: 5, modulation: "nrz", payloadRatio: 8 / 10, nyquistHz: 2.5e9, serdesJPerBit: 30e-12, fecJPerBit: 0, retimerJPerBit: 3.5e-12, budgetDb: 17 },
  "3.0": { gen: "3.0", gtPerSec: 8, modulation: "nrz", payloadRatio: 128 / 130, nyquistHz: 4e9, serdesJPerBit: 22e-12, fecJPerBit: 0.4e-12, retimerJPerBit: 3e-12, budgetDb: 22 },
  "4.0": { gen: "4.0", gtPerSec: 16, modulation: "nrz", payloadRatio: 128 / 130, nyquistHz: 8e9, serdesJPerBit: 16e-12, fecJPerBit: 0.8e-12, retimerJPerBit: 2.5e-12, budgetDb: 28 },
  "5.0": { gen: "5.0", gtPerSec: 32, modulation: "nrz", payloadRatio: 128 / 130, nyquistHz: 16e9, serdesJPerBit: 12e-12, fecJPerBit: 2e-12, retimerJPerBit: 2.2e-12, budgetDb: 36 },
  "6.0": { gen: "6.0", gtPerSec: 64, modulation: "pam4", payloadRatio: 242 / 256, nyquistHz: 16e9, serdesJPerBit: 10e-12, fecJPerBit: 3.5e-12, retimerJPerBit: 2e-12, budgetDb: 32 },
  "7.0": { gen: "7.0", gtPerSec: 128, modulation: "pam4", payloadRatio: 242 / 256, nyquistHz: 32e9, serdesJPerBit: 9e-12, fecJPerBit: 5e-12, retimerJPerBit: 1.8e-12, budgetDb: 36 },
};

export type ChipsetId =
  | "nf520"
  | "p45"
  | "z77"
  | "h610"
  | "b660"
  | "z690"
  | "z790"
  | "z890"
  | "a620"
  | "b650"
  | "x670e"
  | "x870e"
  | "trx50"
  | "wrx90"
  | "w790";

export type Chipset = {
  id: ChipsetId;
  label: string;
  family: string;
  pegLanes: number;
  pegGen: PcieGen;
  memChannels: number;
  dram: readonly DramKind[];
  pchW: number;
  traceCm: number;
  laminate: LaminateName;
  /** Retimers the board can place on the CPU–GPU run. */
  maxRetimers: number;
};

export const CHIPSETS: Record<ChipsetId, Chipset> = {
  nf520: { id: "nf520", label: "nForce 520", family: "DDR2 · 2 ch", pegLanes: 16, pegGen: "1.0", memChannels: 2, dram: ["ddr2"], pchW: 11, traceCm: 25, laminate: "fr4", maxRetimers: 0 },
  p45: { id: "p45", label: "P45", family: "DDR3 · 2 ch", pegLanes: 16, pegGen: "2.0", memChannels: 2, dram: ["ddr3"], pchW: 8, traceCm: 16, laminate: "fr4", maxRetimers: 0 },
  z77: { id: "z77", label: "Z77", family: "DDR3 · 2 ch", pegLanes: 16, pegGen: "3.0", memChannels: 2, dram: ["ddr3"], pchW: 6.5, traceCm: 13, laminate: "fr4", maxRetimers: 0 },
  h610: { id: "h610", label: "H610", family: "DDR4 · 2 ch", pegLanes: 16, pegGen: "4.0", memChannels: 2, dram: ["ddr4"], pchW: 6, traceCm: 20, laminate: "fr4", maxRetimers: 0 },
  b660: { id: "b660", label: "B660", family: "DDR4 · 2 ch", pegLanes: 16, pegGen: "4.0", memChannels: 2, dram: ["ddr4"], pchW: 6, traceCm: 13, laminate: "fr4", maxRetimers: 0 },
  z690: { id: "z690", label: "Z690", family: "DDR4/5 · 2 ch", pegLanes: 16, pegGen: "5.0", memChannels: 2, dram: ["ddr4", "ddr5"], pchW: 6, traceCm: 12, laminate: "fr4", maxRetimers: 0 },
  z790: { id: "z790", label: "Z790", family: "DDR4/5 · 2 ch", pegLanes: 16, pegGen: "5.0", memChannels: 2, dram: ["ddr4", "ddr5"], pchW: 6, traceCm: 11, laminate: "fr4", maxRetimers: 0 },
  z890: { id: "z890", label: "Z890", family: "DDR5 · 2 ch", pegLanes: 16, pegGen: "5.0", memChannels: 2, dram: ["ddr5"], pchW: 8, traceCm: 9.5, laminate: "megtron", maxRetimers: 0 },
  a620: { id: "a620", label: "A620", family: "DDR5 · 2 ch", pegLanes: 16, pegGen: "4.0", memChannels: 2, dram: ["ddr5"], pchW: 7, traceCm: 14, laminate: "fr4", maxRetimers: 0 },
  b650: { id: "b650", label: "B650", family: "DDR5 · 2 ch", pegLanes: 16, pegGen: "4.0", memChannels: 2, dram: ["ddr5"], pchW: 7, traceCm: 12, laminate: "fr4", maxRetimers: 0 },
  x670e: { id: "x670e", label: "X670E", family: "DDR5 · 2 ch", pegLanes: 16, pegGen: "5.0", memChannels: 2, dram: ["ddr5"], pchW: 14, traceCm: 10, laminate: "megtron", maxRetimers: 0 },
  x870e: { id: "x870e", label: "X870E", family: "DDR5 · 2 ch", pegLanes: 16, pegGen: "5.0", memChannels: 2, dram: ["ddr5"], pchW: 15, traceCm: 9, laminate: "megtron", maxRetimers: 0 },
  trx50: { id: "trx50", label: "TRX50", family: "DDR5 · 4 ch", pegLanes: 16, pegGen: "5.0", memChannels: 4, dram: ["ddr5"], pchW: 12, traceCm: 14, laminate: "megtron", maxRetimers: 1 },
  wrx90: { id: "wrx90", label: "WRX90", family: "DDR5 · 8 ch", pegLanes: 16, pegGen: "5.0", memChannels: 8, dram: ["ddr5"], pchW: 18, traceCm: 16, laminate: "megtron", maxRetimers: 1 },
  w790: { id: "w790", label: "W790", family: "DDR5 · 8 ch · FR-4", pegLanes: 16, pegGen: "5.0", memChannels: 8, dram: ["ddr5"], pchW: 15, traceCm: 20, laminate: "fr4", maxRetimers: 1 },
};

export const CHIPSET_ORDER: readonly ChipsetId[] = [
  "nf520", "p45", "z77", "h610", "b660", "z690", "z790", "z890",
  "a620", "b650", "x670e", "x870e", "trx50", "wrx90", "w790",
];

export type CpuArchId = "legacy" | "ivy" | "raptor" | "arrow" | "zen4" | "zen5" | "storm";

type CpuArch = {
  id: CpuArchId;
  label: string;
  processNm: number;
  smt: 1 | 2;
  ratedCores: number;
  /** IEEE FP64 FLOPs per core per cycle, FMA counted as two. */
  dpFlopsPerCycle: number;
  fRefHz: number;
  fRatedHz: number;
  fMinHz: number;
  vRef: number;
  /** Linear regulator slope [V/Hz] around fRef. */
  vPerHz: number;
  vOcPerHz: number;
  /** Dynamic energy at vRef [J/core/cycle]. */
  energyRefJ: number;
  /** Leakage of one core at 75 °C and vRef [W]. */
  leakWAt75: number;
  uncoreW: number;
  imcBaseW: number;
  /** Extra IMC power per GT/s of DRAM rate, per channel [W]. */
  imcPerGTs: number;
  meshWPerCore: number;
  ioGen: PcieGen;
  dram: readonly DramKind[];
  tMaxC: number;
};

export const CPU_ARCH: Record<CpuArchId, CpuArch> = {
  legacy: { id: "legacy", label: "K8 / Core-era", processNm: 65, smt: 2, ratedCores: 4, dpFlopsPerCycle: 2, fRefHz: 2.6e9, fRatedHz: 3.1e9, fMinHz: 1e9, vRef: 1.25, vPerHz: 0.1e-9, vOcPerHz: 0.16e-9, energyRefJ: 5.6e-9, leakWAt75: 1.4, uncoreW: 8, imcBaseW: 2.2, imcPerGTs: 0.8, meshWPerCore: 0.04, ioGen: "2.0", dram: ["ddr2", "ddr3"], tMaxC: 72 },
  ivy: { id: "ivy", label: "Ivy Bridge", processNm: 22, smt: 2, ratedCores: 6, dpFlopsPerCycle: 8, fRefHz: 3.5e9, fRatedHz: 3.9e9, fMinHz: 1.2e9, vRef: 1.15, vPerHz: 0.09e-9, vOcPerHz: 0.14e-9, energyRefJ: 4.2e-9, leakWAt75: 1.1, uncoreW: 10, imcBaseW: 1.8, imcPerGTs: 0.55, meshWPerCore: 0.05, ioGen: "3.0", dram: ["ddr3"], tMaxC: 85 },
  raptor: { id: "raptor", label: "Raptor Cove", processNm: 10, smt: 2, ratedCores: 24, dpFlopsPerCycle: 16, fRefHz: 4.5e9, fRatedHz: 5.5e9, fMinHz: 0.8e9, vRef: 1.2, vPerHz: 0.07e-9, vOcPerHz: 0.11e-9, energyRefJ: 2.2e-9, leakWAt75: 0.9, uncoreW: 16, imcBaseW: 1.5, imcPerGTs: 0.34, meshWPerCore: 0.06, ioGen: "5.0", dram: ["ddr4", "ddr5"], tMaxC: 100 },
  arrow: { id: "arrow", label: "Arrow Lake", processNm: 3, smt: 1, ratedCores: 24, dpFlopsPerCycle: 16, fRefHz: 4.6e9, fRatedHz: 5.4e9, fMinHz: 0.8e9, vRef: 1.05, vPerHz: 0.06e-9, vOcPerHz: 0.1e-9, energyRefJ: 1.5e-9, leakWAt75: 0.55, uncoreW: 14, imcBaseW: 1.3, imcPerGTs: 0.3, meshWPerCore: 0.05, ioGen: "5.0", dram: ["ddr5"], tMaxC: 100 },
  zen4: { id: "zen4", label: "Zen 4", processNm: 5, smt: 2, ratedCores: 16, dpFlopsPerCycle: 16, fRefHz: 4.8e9, fRatedHz: 5.7e9, fMinHz: 0.8e9, vRef: 1.1, vPerHz: 0.07e-9, vOcPerHz: 0.12e-9, energyRefJ: 1.7e-9, leakWAt75: 0.75, uncoreW: 14, imcBaseW: 1.4, imcPerGTs: 0.32, meshWPerCore: 0.05, ioGen: "5.0", dram: ["ddr5"], tMaxC: 95 },
  zen5: { id: "zen5", label: "Zen 5", processNm: 4, smt: 2, ratedCores: 16, dpFlopsPerCycle: 16, fRefHz: 5e9, fRatedHz: 5.5e9, fMinHz: 0.8e9, vRef: 1.05, vPerHz: 0.065e-9, vOcPerHz: 0.11e-9, energyRefJ: 1.45e-9, leakWAt75: 0.62, uncoreW: 13, imcBaseW: 1.35, imcPerGTs: 0.3, meshWPerCore: 0.045, ioGen: "5.0", dram: ["ddr5"], tMaxC: 95 },
  storm: { id: "storm", label: "Storm Peak", processNm: 5, smt: 2, ratedCores: 96, dpFlopsPerCycle: 16, fRefHz: 2.5e9, fRatedHz: 5.1e9, fMinHz: 1e9, vRef: 0.9, vPerHz: 0.05e-9, vOcPerHz: 0.09e-9, energyRefJ: 1.15e-9, leakWAt75: 0.3, uncoreW: 40, imcBaseW: 1.6, imcPerGTs: 0.28, meshWPerCore: 0.03, ioGen: "5.0", dram: ["ddr5"], tMaxC: 95 },
};

export const CPU_ORDER: readonly CpuArchId[] = ["legacy", "ivy", "raptor", "arrow", "zen4", "zen5", "storm"];

export type GpuArchId = "tesla" | "kepler" | "maxwell" | "turing" | "ampere" | "ada" | "hopper" | "blackwell" | "halo";

type GpuArch = {
  id: GpuArchId;
  label: string;
  /** Drawn gate length, the foundry node [nm]. */
  processNm: number;
  /** FP32 FLOPs per shader per clock. Two means one FMA. */
  fp32PerShader: number;
  fp64PerShader: number;
  /** FLOPs or IOPs per tensor core per clock. Missing means the pipe does not exist. */
  tensor: Partial<Record<Precision, number>>;
  joulePerOp: Partial<Record<Precision, number>>;
  fRefHz: number;
  fRatedHz: number;
  fMinHz: number;
  vRef: number;
  vPerHz: number;
  vOcPerHz: number;
  leakWPerShader75: number;
  tMaxC: number;
  ioGen: PcieGen;
  vram: readonly VramKind[];
};

export const GPU_ARCH: Record<GpuArchId, GpuArch> = {
  tesla: { id: "tesla", label: "Tesla (G92)", processNm: 65, fp32PerShader: 2, fp64PerShader: 0, tensor: {}, joulePerOp: { fp32: 250e-12 }, fRefHz: 1.625e9, fRatedHz: 1.7e9, fMinHz: 0.4e9, vRef: 1.1, vPerHz: 0.3e-9, vOcPerHz: 0.4e-9, leakWPerShader75: 0.12, tMaxC: 100, ioGen: "2.0", vram: ["gddr3"] },
  kepler: { id: "kepler", label: "Kepler", processNm: 28, fp32PerShader: 2, fp64PerShader: 2 / 24, tensor: {}, joulePerOp: { fp32: 42e-12, fp64: 400e-12 }, fRefHz: 1.058e9, fRatedHz: 1.2e9, fMinHz: 0.4e9, vRef: 1.1, vPerHz: 0.22e-9, vOcPerHz: 0.32e-9, leakWPerShader75: 0.006, tMaxC: 98, ioGen: "3.0", vram: ["gddr5"] },
  maxwell: { id: "maxwell", label: "Maxwell", processNm: 28, fp32PerShader: 2, fp64PerShader: 2 / 32, tensor: {}, joulePerOp: { fp32: 14e-12, fp64: 80e-12 }, fRefHz: 1.05e9, fRatedHz: 1.2e9, fMinHz: 0.4e9, vRef: 1.05, vPerHz: 0.2e-9, vOcPerHz: 0.3e-9, leakWPerShader75: 0.004, tMaxC: 90, ioGen: "3.0", vram: ["gddr5"] },
  turing: { id: "turing", label: "Turing", processNm: 12, fp32PerShader: 2, fp64PerShader: 2 / 32, tensor: { fp16: 64, int8: 128 }, joulePerOp: { fp32: 8e-12, fp64: 48e-12, fp16: 1.1e-12, int8: 0.7e-12 }, fRefHz: 1.6e9, fRatedHz: 1.9e9, fMinHz: 0.4e9, vRef: 1.0, vPerHz: 0.18e-9, vOcPerHz: 0.28e-9, leakWPerShader75: 0.0026, tMaxC: 88, ioGen: "3.0", vram: ["gddr5", "gddr6"] },
  ampere: { id: "ampere", label: "Ampere", processNm: 8, fp32PerShader: 2, fp64PerShader: 2 / 64, tensor: { fp16: 256, bf16: 256, tf32: 128, int8: 512 }, joulePerOp: { fp32: 9.5e-12, fp64: 30e-12, fp16: 0.55e-12, bf16: 0.55e-12, tf32: 0.85e-12, int8: 0.3e-12 }, fRefHz: 1.7e9, fRatedHz: 1.95e9, fMinHz: 0.4e9, vRef: 1.0, vPerHz: 0.16e-9, vOcPerHz: 0.24e-9, leakWPerShader75: 0.0018, tMaxC: 88, ioGen: "4.0", vram: ["gddr6", "gddr6x"] },
  ada: { id: "ada", label: "Ada", processNm: 5, fp32PerShader: 2, fp64PerShader: 2 / 64, tensor: { fp16: 256, bf16: 256, tf32: 128, fp8: 512, int8: 512 }, joulePerOp: { fp32: 3.2e-12, fp64: 25e-12, fp16: 0.48e-12, bf16: 0.48e-12, tf32: 0.7e-12, fp8: 0.26e-12, int8: 0.22e-12 }, fRefHz: 2.4e9, fRatedHz: 2.6e9, fMinHz: 0.4e9, vRef: 1.0, vPerHz: 0.16e-9, vOcPerHz: 0.22e-9, leakWPerShader75: 0.0014, tMaxC: 88, ioGen: "4.0", vram: ["gddr6", "gddr6x"] },
  hopper: { id: "hopper", label: "Hopper", processNm: 5, fp32PerShader: 2, fp64PerShader: 2 / 64, tensor: { fp64: 64, fp16: 1024, bf16: 1024, tf32: 512, fp8: 2048, int8: 2048 }, joulePerOp: { fp32: 3.5e-12, fp64: 6e-12, fp16: 0.32e-12, bf16: 0.32e-12, tf32: 0.5e-12, fp8: 0.18e-12, int8: 0.16e-12 }, fRefHz: 1.7e9, fRatedHz: 1.85e9, fMinHz: 0.5e9, vRef: 0.95, vPerHz: 0.14e-9, vOcPerHz: 0.2e-9, leakWPerShader75: 0.0016, tMaxC: 85, ioGen: "5.0", vram: ["hbm"] },
  blackwell: { id: "blackwell", label: "Blackwell", processNm: 4, fp32PerShader: 2, fp64PerShader: 2 / 64, tensor: { fp64: 32, fp16: 512, bf16: 512, tf32: 256, fp8: 1024, int8: 1024 }, joulePerOp: { fp32: 4.5e-12, fp64: 8e-12, fp16: 0.28e-12, bf16: 0.28e-12, tf32: 0.42e-12, fp8: 0.15e-12, int8: 0.13e-12 }, fRefHz: 2.2e9, fRatedHz: 2.7e9, fMinHz: 0.4e9, vRef: 0.95, vPerHz: 0.14e-9, vOcPerHz: 0.2e-9, leakWPerShader75: 0.0012, tMaxC: 88, ioGen: "6.0", vram: ["gddr6x", "gddr7", "hbm"] },
  halo: { id: "halo", label: "Halo PHY", processNm: 3, fp32PerShader: 2, fp64PerShader: 2 / 32, tensor: { fp64: 64, fp16: 512, bf16: 512, tf32: 256, fp8: 1024, int8: 1024 }, joulePerOp: { fp32: 2.4e-12, fp64: 5e-12, fp16: 0.24e-12, bf16: 0.24e-12, tf32: 0.36e-12, fp8: 0.13e-12, int8: 0.11e-12 }, fRefHz: 2.3e9, fRatedHz: 2.8e9, fMinHz: 0.4e9, vRef: 0.92, vPerHz: 0.12e-9, vOcPerHz: 0.18e-9, leakWPerShader75: 0.001, tMaxC: 90, ioGen: "7.0", vram: ["gddr5", "gddr5x", "gddr6", "gddr6x", "gddr7", "hbm"] },
};

export const GPU_ORDER: readonly GpuArchId[] = ["tesla", "kepler", "maxwell", "turing", "ampere", "ada", "hopper", "blackwell", "halo"];

type MemSpec = {
  kind: DramKind | VramKind;
  label: string;
  vdd: number;
  rateMin: number;
  rateMax: number;
  /** CK = data-rate / divisor. DDR is 2. GDDR6-class is 8. */
  clockDivisor: number;
  joulePerBit: number;
  leakWPerGb: number;
  note: string;
};

export const DRAM_SPEC: Record<DramKind, MemSpec> = {
  ddr2: { kind: "ddr2", label: "DDR2", vdd: 1.8, rateMin: 400, rateMax: 1066, clockDivisor: 2, joulePerBit: 70e-12, leakWPerGb: 0.08, note: "1.8 V, 2n prefetch" },
  ddr3: { kind: "ddr3", label: "DDR3", vdd: 1.5, rateMin: 800, rateMax: 2133, clockDivisor: 2, joulePerBit: 40e-12, leakWPerGb: 0.05, note: "1.5 V" },
  ddr4: { kind: "ddr4", label: "DDR4", vdd: 1.2, rateMin: 1600, rateMax: 4800, clockDivisor: 2, joulePerBit: 18e-12, leakWPerGb: 0.03, note: "1.2 V, OC ceiling 4800 MT/s" },
  ddr5: { kind: "ddr5", label: "DDR5", vdd: 1.1, rateMin: 3200, rateMax: 14000, clockDivisor: 2, joulePerBit: 8e-12, leakWPerGb: 0.02, note: "JEDEC through 8400; bench ceiling 14000 MT/s" },
};

export const VRAM_SPEC: Record<VramKind, MemSpec> = {
  gddr3: { kind: "gddr3", label: "GDDR3", vdd: 1.8, rateMin: 1000, rateMax: 2600, clockDivisor: 2, joulePerBit: 45e-12, leakWPerGb: 0.09, note: "1.8 V, 2× CK" },
  gddr5: { kind: "gddr5", label: "GDDR5", vdd: 1.5, rateMin: 3000, rateMax: 8000, clockDivisor: 4, joulePerBit: 22e-12, leakWPerGb: 0.06, note: "NRZ, 4× CK" },
  gddr5x: { kind: "gddr5x", label: "GDDR5X", vdd: 1.35, rateMin: 6000, rateMax: 11000, clockDivisor: 8, joulePerBit: 14e-12, leakWPerGb: 0.05, note: "QDR-class, ceiling 11 Gbps" },
  gddr6: { kind: "gddr6", label: "GDDR6", vdd: 1.35, rateMin: 6000, rateMax: 20000, clockDivisor: 8, joulePerBit: 9e-12, leakWPerGb: 0.035, note: "Shipping bins run 14 to 20 Gbps" },
  gddr6x: { kind: "gddr6x", label: "GDDR6X", vdd: 1.35, rateMin: 8000, rateMax: 24000, clockDivisor: 8, joulePerBit: 7e-12, leakWPerGb: 0.03, note: "PAM4. Shipping bins run 19 to 24 Gbps" },
  gddr7: { kind: "gddr7", label: "GDDR7", vdd: 1.2, rateMin: 10000, rateMax: 32000, clockDivisor: 8, joulePerBit: 5e-12, leakWPerGb: 0.025, note: "PAM3. Shipping bins run 28 to 32 Gbps" },
  hbm: { kind: "hbm", label: "HBM", vdd: 1.1, rateMin: 1000, rateMax: 9600, clockDivisor: 2, joulePerBit: 3.2e-12, leakWPerGb: 0.015, note: "1024-bit stack, HBM2 through HBM3e rates" },
};

export type Cooler = { id: CoolerId; label: string; cpuRth: number; gpuRth: number; fanW: number };

export const COOLERS: Record<CoolerId, Cooler> = {
  air: { id: "air", label: "Tower air", cpuRth: 0.2, gpuRth: 0.11, fanW: 2.4 },
  aio240: { id: "aio240", label: "240 mm liquid", cpuRth: 0.11, gpuRth: 0.07, fanW: 4.2 },
  aio360: { id: "aio360", label: "360 mm liquid", cpuRth: 0.075, gpuRth: 0.05, fanW: 6.5 },
  loop: { id: "loop", label: "Custom loop", cpuRth: 0.042, gpuRth: 0.03, fanW: 11 },
};

type CpuConfig = { arch: CpuArchId; cores: number; threads: number; ghz: number; load: number };
type GpuConfig = { arch: GpuArchId; shaders: number; tensors: number; ghz: number; format: Precision; load: number };
type DramConfig = { kind: DramKind; gb: number; megaTransfers: number };
type VramConfig = { kind: VramKind; gb: number; megaTransfers: number; busBits: number; stacks: number };

export type BenchConfig = {
  chipsetId: ChipsetId;
  requestedGen: PcieGen;
  forceGen: boolean;
  forceVram: boolean;
  cpu: CpuConfig;
  gpu: GpuConfig;
  dram: DramConfig;
  vram: VramConfig;
  /** Polymer waveguide, SiN rings, and the laser bank beside the copper x16. */
  optical: OpticalConfig;
  cpuCooler: CoolerId;
  gpuCooler: CoolerId;
  ambientC: number;
};

export type Fault = { domain: "dram" | "vram" | "link" | "optical"; reason: string };

export type FormatRow = {
  format: Precision;
  opsPerSec: number | null;
  unit: "TFLOP/s" | "TOP/s";
};

export type DieRole = "core" | "ecore" | "l3" | "iod" | "sm" | "tensor" | "l2" | "phy";

type DieBlock = {
  id: string;
  role: DieRole;
  /** Origin and size on the die outline, both 0–1. */
  x: number;
  y: number;
  w: number;
  h: number;
  areaMm2: number;
  /** Same silicon area in [nm²]. \(1\,\mathrm{mm}^{2} = 10^{12}\,\mathrm{nm}^{2}\). */
  areaNm2: number;
  powerW: number;
  tempC: number;
};

export type DieMap = {
  widthMm: number;
  heightMm: number;
  /** Silicon width [nm]. */
  widthNm: number;
  /** Silicon height [nm]. */
  heightNm: number;
  /** Silicon area, excluding substrate gaps and tensor insets. [mm²] */
  areaMm2: number;
  /** Same silicon area [nm²]. */
  areaNm2: number;
  /** Package power sitting on that silicon. [W/mm²] */
  densityWPerMm2: number;
  coolestC: number;
  blocks: readonly DieBlock[];
};

export type BenchReport = {
  config: BenchConfig;
  notes: string[];
  chipset: Chipset;
  cpuArch: CpuArch;
  gpuArch: GpuArch;
  link: {
    attempted: PcieGen;
    trained: PcieGen | null;
    lanes: number;
    up: boolean;
    reason: string;
    bytesPerSecEachWay: number;
    ilDb: number;
    budgetDb: number;
    retimers: number;
    latencyS: number;
    endpointW: number;
    retimerW: number;
    nyquistHz: number;
  };
  dram: {
    trained: boolean;
    reason: string;
    clockHz: number;
    channels: number;
    bytesPerSec: number;
    watts: number;
  };
  vram: {
    trained: boolean;
    reason: string;
    clockHz: number;
    busBits: number;
    stacks: number;
    bytesPerSec: number;
    watts: number;
  };
  cpu: {
    watts: number;
    junctionC: number;
    tMaxC: number;
    scale: number;
    throttled: boolean;
    runaway: boolean;
    flopPerSecDp: number;
    voltage: number;
    deliveredGhz: number;
    die: DieMap;
  };
  gpu: {
    asicW: number;
    junctionC: number;
    tMaxC: number;
    scale: number;
    throttled: boolean;
    runaway: boolean;
    opsPerSec: number | null;
    unit: "TFLOP/s" | "TOP/s";
    deliveredGhz: number;
    voltage: number;
    byFormat: FormatRow[];
    die: DieMap;
  };
  pchW: number;
  fanW: number;
  optical: OpticalReport;
  electricalW: number;
  heatW: number;
  faults: Fault[];
};

function clamp(n: number, lo: number, hi: number): number {
  // Math.max/min propagate NaN, which would poison every downstream figure.
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function earlier(a: PcieGen, b: PcieGen): PcieGen {
  return PCIE_GENS.indexOf(a) <= PCIE_GENS.indexOf(b) ? a : b;
}

function isPcie(value: string): value is PcieGen {
  return (PCIE_GENS as readonly string[]).includes(value);
}

function nearestBus(bits: number): number {
  return GDDR_BUS_BITS.reduce((best, item) => (Math.abs(item - bits) < Math.abs(best - bits) ? item : best));
}

/**
 * Clamp a board into the bench limits.
 *
 * Cores stop at 256, threads at min(512, cores × SMT), tensor cores at 18432.
 * Memory rate stops at the format cap, which itself stops at 14000 MT/s.
 */
export function sanitize(input: BenchConfig): BenchConfig {
  const chipsetId = Object.hasOwn(CHIPSETS, input.chipsetId) ? input.chipsetId : "x670e";
  const cpuArch = CPU_ARCH[input.cpu.arch] ? input.cpu.arch : "zen5";
  const gpuArch = GPU_ARCH[input.gpu.arch] ? input.gpu.arch : "ada";
  const cpuSpec = CPU_ARCH[cpuArch];
  const cores = Math.round(clamp(input.cpu.cores, 1, CORE_MAX));
  const threadCap = Math.min(THREAD_MAX, cores * cpuSpec.smt);
  const threads = Math.round(clamp(input.cpu.threads, cores, threadCap));
  const dramKind = DRAM_SPEC[input.dram.kind] ? input.dram.kind : "ddr5";
  const vramKind = VRAM_SPEC[input.vram.kind] ? input.vram.kind : "gddr6x";
  const dramSpec = DRAM_SPEC[dramKind];
  const vramSpec = VRAM_SPEC[vramKind];
  const modulatorId = isModulatorId(input.optical?.modulator) ? input.optical.modulator : DEFAULT_OPTICAL.modulator;
  const format = PRECISIONS.includes(input.gpu.format) ? input.gpu.format : "fp16";
  return {
    chipsetId,
    requestedGen: isPcie(input.requestedGen) ? input.requestedGen : "5.0",
    forceGen: Boolean(input.forceGen),
    forceVram: Boolean(input.forceVram),
    cpuCooler: COOLERS[input.cpuCooler] ? input.cpuCooler : "aio360",
    gpuCooler: COOLERS[input.gpuCooler] ? input.gpuCooler : "air",
    ambientC: clamp(input.ambientC, 10, 45),
    cpu: {
      arch: cpuArch,
      cores,
      threads,
      ghz: clamp(input.cpu.ghz, cpuSpec.fMinHz / 1e9, 6),
      load: clamp(input.cpu.load, 0.05, 1),
    },
    gpu: {
      arch: gpuArch,
      shaders: Math.round(clamp(input.gpu.shaders, SHADER_MIN, SHADER_MAX)),
      tensors: Math.round(clamp(input.gpu.tensors, 0, TENSOR_MAX)),
      ghz: clamp(input.gpu.ghz, GPU_ARCH[gpuArch].fMinHz / 1e9, 3.2),
      format,
      load: clamp(input.gpu.load, 0.05, 1),
    },
    dram: {
      kind: dramKind,
      gb: clamp(input.dram.gb, DRAM_MIN_GB, 2048),
      megaTransfers: clamp(input.dram.megaTransfers, dramSpec.rateMin, dramSpec.rateMax),
    },
    vram: {
      kind: vramKind,
      gb: clamp(input.vram.gb, VRAM_MIN_GB, 256),
      megaTransfers: clamp(input.vram.megaTransfers, vramSpec.rateMin, vramSpec.rateMax),
      busBits: nearestBus(input.vram.busBits),
      stacks: Math.round(clamp(input.vram.stacks, 1, 8)),
    },
    optical: {
      enabled: (input.optical ?? DEFAULT_OPTICAL).enabled !== false,
      band: (input.optical ?? DEFAULT_OPTICAL).band === "o1310" ? "o1310" : "c1550",
      lanes: Math.round(clamp((input.optical ?? DEFAULT_OPTICAL).lanes, 1, 32)),
      gbitPerLane: clamp((input.optical ?? DEFAULT_OPTICAL).gbitPerLane, 2.5, 112),
      track: (input.optical ?? DEFAULT_OPTICAL).track !== false,
      modulator: modulatorId,
      modLengthMm: clamp(input.optical?.modLengthMm ?? MODULATORS[modulatorId].lengthMm, MODULATOR_LENGTH_MM.min, MODULATOR_LENGTH_MM.max),
      modSwingV: clamp(input.optical?.modSwingV ?? MODULATORS[modulatorId].swingV, MODULATOR_SWING_V.min, MODULATOR_SWING_V.max),
    },
  };
}

export function withConfig(
  base: BenchConfig,
  patch: Partial<Omit<BenchConfig, "cpu" | "gpu" | "dram" | "vram" | "optical">> & {
    cpu?: Partial<CpuConfig>;
    gpu?: Partial<GpuConfig>;
    dram?: Partial<DramConfig>;
    vram?: Partial<VramConfig>;
    optical?: Partial<OpticalConfig>;
  },
): BenchConfig {
  return sanitize({
    ...base,
    ...patch,
    cpu: { ...base.cpu, ...patch.cpu },
    gpu: { ...base.gpu, ...patch.gpu },
    dram: { ...base.dram, ...patch.dram },
    vram: { ...base.vram, ...patch.vram },
    optical: { ...(base.optical ?? DEFAULT_OPTICAL), ...patch.optical },
  });
}

/**
 * CPU package, GPU package, and the x16 connector [dB].
 * \[ IL_{fix} = 1.25 \,(f / 10^{9})^{0.9} \]
 */
function fixtureLossDb(freqHz: number): number {
  if (freqHz <= 0) return 0;
  return assumed("fixtureLoss") * (freqHz / 1e9) ** 0.9;
}

/** Board trace plus fixture [dB] at one frequency. */
function channelLossDb(freqHz: number, lengthCm: number, name: LaminateName): number {
  return totalLossDbPerM(freqHz, name) * (lengthCm / 100) + fixtureLossDb(freqHz);
}

/** How many retimers a mask needs. Each retimer opens a new segment. */
function requiredRetimers(ilDb: number, budgetDb: number): number {
  if (ilDb <= budgetDb + 1e-9) return 0;
  const segments = Math.max(1, Math.ceil(ilDb / budgetDb - 1e-9));
  return segments - 1;
}

/** One-direction payload rate [B/s]. */
function pcieBytesPerSec(gen: PcieGen, lanes: number): number {
  const spec = PCIE[gen];
  return (lanes * spec.gtPerSec * 1e9 * spec.payloadRatio) / 8;
}

/** Raw line bits one direction [bit/s], before the payload ratio. */
function pcieRawBitsPerSec(gen: PcieGen, lanes: number): number {
  return lanes * PCIE[gen].gtPerSec * 1e9;
}

/** One endpoint, both directions counted inside the pJ/bit figure [W]. */
function endpointWatts(gen: PcieGen, lanes: number, segmentIlDb: number): number {
  return pcieRawBitsPerSec(gen, lanes) * phyJPerBit(PCIE[gen], segmentIlDb);
}

function retimerBankWatts(gen: PcieGen, lanes: number, count: number): number {
  if (count <= 0) return 0;
  return count * pcieRawBitsPerSec(gen, lanes) * 2 * PCIE[gen].retimerJPerBit;
}

function coreVoltage(arch: CpuArch, freqHz: number): number {
  const linear = arch.vPerHz * (freqHz - arch.fRefHz);
  const oc = arch.vOcPerHz * Math.max(0, freqHz - arch.fRatedHz);
  return clamp(arch.vRef + linear + oc, 0.55, 1.5);
}

function smtFactor(threads: number, cores: number, gain: number): number {
  if (threads <= cores) return 1;
  return 1 + gain * ((threads - cores) / cores);
}

function stretch(cores: number, rated: number): number {
  if (cores <= rated) return 1;
  return 1 + 0.12 * ((cores - rated) / rated);
}

/** Dynamic core power at the requested clock, before thermal throttle [W]. */
function cpuDynamicW(arch: CpuArch, cores: number, threads: number, freqHz: number, load: number): number {
  const v = coreVoltage(arch, freqHz);
  const perCore = freqHz * arch.energyRefJ * (v / arch.vRef) ** 2;
  return cores * perCore * smtFactor(threads, cores, 0.12) * stretch(cores, arch.ratedCores) * load;
}

/** Leakage at a known junction temperature [W]. Doubles every 10 K from 75 °C. */
function cpuLeakW(arch: CpuArch, cores: number, freqHz: number, tempC: number): number {
  const v = coreVoltage(arch, freqHz);
  return cores * arch.leakWAt75 * (v / arch.vRef) * 2 ** ((tempC - 75) / 10);
}

function cpuFlopPerSec(arch: CpuArch, cores: number, threads: number, freqHz: number, load: number): number {
  return cores * freqHz * arch.dpFlopsPerCycle * smtFactor(threads, cores, 0.28) * stretch(cores, arch.ratedCores) * load;
}

function gpuVoltage(arch: GpuArch, freqHz: number): number {
  const linear = arch.vPerHz * (freqHz - arch.fRefHz);
  const oc = arch.vOcPerHz * Math.max(0, freqHz - arch.fRatedHz);
  return clamp(arch.vRef + linear + oc, 0.55, 1.25);
}

/**
 * Peak ops/s for one format. Null when that pipe is not on the die.
 * Tensor kappa wins over the shader path when both exist.
 */
function gpuOpsPerSec(arch: GpuArch, shaders: number, tensors: number, freqHz: number, format: Precision): number | null {
  const kappa = arch.tensor[format];
  if (kappa !== undefined && kappa > 0) return tensors * freqHz * kappa;
  if (format === "fp32") return shaders * freqHz * arch.fp32PerShader;
  if (format === "fp64") return arch.fp64PerShader > 0 ? shaders * freqHz * arch.fp64PerShader : null;
  return null;
}

function gpuDynamicW(
  arch: GpuArch,
  shaders: number,
  tensors: number,
  freqHz: number,
  format: Precision,
  load: number,
): number {
  const ops = gpuOpsPerSec(arch, shaders, tensors, freqHz, format);
  const energy = arch.joulePerOp[format];
  if (ops === null || energy === undefined) return 0;
  const v = gpuVoltage(arch, freqHz);
  return ops * energy * (v / arch.vRef) ** 2 * load;
}

function gpuLeakW(arch: GpuArch, shaders: number, freqHz: number, tempC: number): number {
  const v = gpuVoltage(arch, freqHz);
  return shaders * arch.leakWPerShader75 * (v / arch.vRef) * 2 ** ((tempC - 75) / 10);
}

/** DRAM or VRAM bandwidth [B/s] from a pin data-rate and a bus width. */
function memoryBytesPerSec(rateMt: number, busBits: number): number {
  return (busBits / 8) * rateMt * 1e6;
}

/**
 * Active plus idle memory power [W].
 * \[ P = e_{bit} \cdot 8 B \cdot (0.08 + 0.92 u) + p_{GB} C \]
 */
function memoryWatts(spec: MemSpec, bytesPerSec: number, gb: number, activity: number): number {
  const bits = 8 * bytesPerSec;
  const u = 0.08 + 0.92 * clamp(activity, 0, 1);
  return spec.joulePerBit * bits * u + spec.leakWPerGb * gb;
}

type Thermal = { tempC: number; watts: number; scale: number; throttled: boolean; runaway: boolean };

/**
 * Find a frequency scale in (0, 1] whose leakage fixed-point stays at or under tMax.
 * Dynamic power is multiplied by `scale`. Leakage is not.
 */
function solvePackage(
  powerAt: (tempC: number, scale: number) => number,
  rth: number,
  ambientC: number,
  tMax: number,
): Thermal {
  const converge = (scale: number): { tempC: number; watts: number } => {
    let tempC = ambientC;
    let watts = powerAt(tempC, scale);
    for (let i = 0; i < 48; i += 1) {
      watts = powerAt(tempC, scale);
      const next = ambientC + watts * rth;
      if (!Number.isFinite(next) || !Number.isFinite(watts)) {
        return { tempC: Number.NaN, watts: Number.NaN };
      }
      if (Math.abs(next - tempC) < 1e-4) return { tempC: next, watts };
      // Damping stops the leakage loop from oscillating.
      tempC = tempC + 0.45 * (next - tempC);
    }
    // Not settled after 48 damped steps. A slow but bounded climb is kept; a blow-up is a divergence.
    return tempC < 1000 ? { tempC, watts } : { tempC: Number.NaN, watts: Number.NaN };
  };

  const full = converge(1);
  if (full.tempC <= tMax + 1e-3) {
    return { tempC: full.tempC, watts: full.watts, scale: 1, throttled: false, runaway: false };
  }
  let lo = 0;
  let hi = 1;
  let best = converge(0);
  for (let i = 0; i < 28; i += 1) {
    const mid = (lo + hi) / 2;
    const trial = converge(mid);
    if (trial.tempC <= tMax) {
      lo = mid;
      best = trial;
    } else {
      hi = mid;
    }
  }
  // No frequency scale held the package under tMax, so `best` is the diverged scale-0 solve (NaN).
  // Leakage alone out-runs the cooler: the part sits at its thermal trip with the clock gated off.
  if (!Number.isFinite(best.tempC) || !Number.isFinite(best.watts)) {
    return { tempC: tMax, watts: powerAt(tMax, 0), scale: 0, throttled: true, runaway: true };
  }
  const runaway = best.tempC > tMax + 0.2;
  return { tempC: best.tempC, watts: best.watts, scale: lo, throttled: true, runaway };
}

function dramLegal(chipset: Chipset, cpu: CpuArch, kind: DramKind): boolean {
  return chipset.dram.includes(kind) && cpu.dram.includes(kind);
}

function vramLegal(gpu: GpuArch, kind: VramKind, force: boolean): boolean {
  return force || gpu.vram.includes(kind);
}

/**
 * Pick a DRAM kind both the board and the CPU can train.
 * If the CPU cannot speak the board at all, swap in an architecture that can.
 */
export function fitMemory(input: BenchConfig): BenchConfig {
  const config = sanitize(input);
  const chip = CHIPSETS[config.chipsetId];
  let cpu = CPU_ARCH[config.cpu.arch];
  const prefer: DramKind[] = ["ddr5", "ddr4", "ddr3", "ddr2"];
  let kind = prefer.find((item) => dramLegal(chip, cpu, item));
  let archId = config.cpu.arch;
  if (!kind) {
    const boardKind = prefer.find((item) => chip.dram.includes(item)) ?? chip.dram[0];
    const match = CPU_ORDER.find((id) => CPU_ARCH[id].dram.includes(boardKind));
    archId = match ?? archId;
    cpu = CPU_ARCH[archId];
    kind = boardKind;
  }
  const defaults: Record<DramKind, number> = { ddr2: 800, ddr3: 1600, ddr4: 3200, ddr5: 5600 };
  const gpu = GPU_ARCH[config.gpu.arch];
  const vPrefer: VramKind[] = ["gddr7", "gddr6x", "gddr6", "gddr5x", "gddr5", "gddr3", "hbm"];
  const vKind = vPrefer.find((item) => gpu.vram.includes(item)) ?? gpu.vram[0];
  const vDefaults: Record<VramKind, number> = {
    gddr3: 1900, gddr5: 7000, gddr5x: 10000, gddr6: 14000, gddr6x: 21000, gddr7: 28000, hbm: 6400,
  };
  return sanitize({
    ...config,
    forceVram: false, optical: { ...DEFAULT_OPTICAL },
    cpu: { ...config.cpu, arch: archId },
    dram: { ...config.dram, kind, megaTransfers: defaults[kind] },
    vram: { ...config.vram, kind: vKind, megaTransfers: vDefaults[vKind] },
  });
}

/** Drop the force flag so the link trains at the slowest rated PHY. */
export function ratedLink(input: BenchConfig): BenchConfig {
  return sanitize({ ...sanitize(input), forceGen: false });
}

/** Bulk silicon conductivity [W/m/K] used for hotspot constriction. */
const K_SILICON = 130;

type CpuFloor = {
  style: "chiplet" | "monolith";
  coresPerCcd: number;
  coreMm2: number;
  eCoreMm2: number;
  pCap: number;
  l3PerCore: number;
  iodMm2: number;
};

type GpuFloor = { shadersPerSm: number; smMm2: number; l2Fraction: number };

/** Published-order die areas. A Zen CCD is ~70 mm²; a 16-core dense tile is smaller per core. */
const CPU_FLOOR: Record<CpuArchId, CpuFloor> = {
  legacy: { style: "monolith", coresPerCcd: 4, coreMm2: 16, eCoreMm2: 0, pCap: 99, l3PerCore: 6, iodMm2: 22 },
  ivy: { style: "monolith", coresPerCcd: 6, coreMm2: 11, eCoreMm2: 0, pCap: 99, l3PerCore: 4.5, iodMm2: 28 },
  raptor: { style: "monolith", coresPerCcd: 8, coreMm2: 7.4, eCoreMm2: 2.6, pCap: 8, l3PerCore: 2.2, iodMm2: 36 },
  arrow: { style: "monolith", coresPerCcd: 8, coreMm2: 4.2, eCoreMm2: 1.8, pCap: 8, l3PerCore: 1.6, iodMm2: 86 },
  zen4: { style: "chiplet", coresPerCcd: 8, coreMm2: 3.6, eCoreMm2: 0, pCap: 99, l3PerCore: 2.4, iodMm2: 122 },
  zen5: { style: "chiplet", coresPerCcd: 8, coreMm2: 3.1, eCoreMm2: 0, pCap: 99, l3PerCore: 2.1, iodMm2: 128 },
  storm: { style: "chiplet", coresPerCcd: 8, coreMm2: 3.6, eCoreMm2: 0, pCap: 999, l3PerCore: 2.4, iodMm2: 400 },
};

const GPU_FLOOR: Record<GpuArchId, GpuFloor> = {
  tesla: { shadersPerSm: 8, smMm2: 13, l2Fraction: 0.1 },
  kepler: { shadersPerSm: 192, smMm2: 25, l2Fraction: 0.12 },
  maxwell: { shadersPerSm: 128, smMm2: 5.5, l2Fraction: 0.12 },
  turing: { shadersPerSm: 64, smMm2: 3.8, l2Fraction: 0.14 },
  ampere: { shadersPerSm: 128, smMm2: 3.1, l2Fraction: 0.16 },
  ada: { shadersPerSm: 128, smMm2: 2.5, l2Fraction: 0.18 },
  hopper: { shadersPerSm: 128, smMm2: 3.4, l2Fraction: 0.2 },
  blackwell: { shadersPerSm: 128, smMm2: 2.2, l2Fraction: 0.18 },
  halo: { shadersPerSm: 128, smMm2: 2.0, l2Fraction: 0.16 },
};

type Box = { id: string; role: DieRole; x: number; y: number; w: number; h: number };

function spanOf(boxes: readonly Box[]): { w: number; h: number } {
  return {
    w: boxes.reduce((max, box) => Math.max(max, box.x + box.w), 0),
    h: boxes.reduce((max, box) => Math.max(max, box.y + box.h), 0),
  };
}

/**
 * Zen-style CCD. Cores sit in two wings around a central L3, which is the
 * floorplan published for Zen 2 through Zen 5. Each CCD is its own die.
 * The I/O die is a second piece of silicon on the package, under the CCDs.
 * Areas stay on the `CPU_FLOOR` figures [mm²].
 */
function chipletBoxes(cores: number, floor: CpuFloor): Box[] {
  const per = Math.max(1, floor.coresPerCcd);
  const nCcd = Math.max(1, Math.ceil(Math.max(cores, 1) / per));
  const cols = Math.min(4, nCcd);
  const coreSide = Math.sqrt(floor.coreMm2);
  const gap = Math.max(0.08, coreSide * 0.055);
  const leftN = Math.ceil(per / 2);
  const wingCols = Math.min(2, leftN);
  const wingRows = Math.ceil(leftN / wingCols);
  const wingW = wingCols * coreSide + Math.max(0, wingCols - 1) * gap;
  const wingH = wingRows * coreSide + Math.max(0, wingRows - 1) * gap;
  const l3Area = Math.max(floor.l3PerCore * per, wingH * coreSide * 0.35);
  const l3W = l3Area / wingH;
  const ccdW = wingW + l3W + wingW + gap * 2;
  const pitchX = ccdW + Math.max(0.7, coreSide * 0.45);
  const pitchY = wingH + Math.max(0.7, coreSide * 0.45);
  const boxes: Box[] = [];
  let placed = 0;
  for (let ccd = 0; ccd < nCcd; ccd += 1) {
    const ox = (ccd % cols) * pitchX;
    const oy = Math.floor(ccd / cols) * pitchY;
    const count = Math.min(per, Math.max(0, cores - placed));
    const l3x = ox + wingW + gap;
    for (let i = 0; i < count; i += 1) {
      const onRight = i >= leftN;
      const local = onRight ? i - leftN : i;
      const col = local % wingCols;
      const row = Math.floor(local / wingCols);
      const x0 = onRight ? l3x + l3W + gap : ox;
      boxes.push({
        id: `core-${placed + i}`,
        role: "core",
        x: x0 + col * (coreSide + gap),
        y: oy + row * (coreSide + gap),
        w: coreSide,
        h: coreSide,
      });
    }
    boxes.push({ id: `l3-${ccd}`, role: "l3", x: l3x, y: oy, w: l3W, h: wingH });
    placed += count;
  }
  const outline = spanOf(boxes);
  const iodW = Math.max(outline.w, Math.sqrt(floor.iodMm2 * 1.35));
  const shift = Math.max(0, (iodW - outline.w) / 2);
  const seated = shift > 0 ? boxes.map((box) => ({ ...box, x: box.x + shift })) : boxes;
  seated.push({
    id: "iod",
    role: "iod",
    x: 0,
    y: outline.h + Math.max(0.55, coreSide * 0.35),
    w: iodW,
    h: floor.iodMm2 / iodW,
  });
  return seated;
}

/**
 * Monolithic client die. P-cores form a grid, E-cores sit in 4-wide clusters
 * under them (Raptor Lake / Arrow Lake), then the shared L3, then the
 * system agent with the memory controller and the PCIe PHY.
 */
function monolithBoxes(cores: number, floor: CpuFloor): Box[] {
  const pCount = floor.eCoreMm2 > 0 ? Math.min(cores, floor.pCap) : cores;
  const eCount = Math.max(0, cores - pCount);
  const pSide = Math.sqrt(floor.coreMm2);
  const eSide = Math.sqrt(floor.eCoreMm2 > 0 ? floor.eCoreMm2 : floor.coreMm2);
  const gap = Math.max(0.1, pSide * 0.07);
  const pCols = pCount <= 1 ? 1 : pCount <= 4 ? 2 : pCount <= 6 ? 3 : pCount <= 8 ? 4 : Math.min(8, pCount);
  const boxes: Box[] = [];
  for (let i = 0; i < pCount; i += 1) {
    boxes.push({
      id: `core-${i}`,
      role: "core",
      x: (i % pCols) * (pSide + gap),
      y: Math.floor(i / pCols) * (pSide + gap),
      w: pSide,
      h: pSide,
    });
  }
  const pBottom = pCount > 0 ? spanOf(boxes).h : 0;
  const cluster = 4;
  const clusters = eCount > 0 ? Math.ceil(eCount / cluster) : 0;
  const clusterCols = Math.min(4, Math.max(clusters, 1));
  const eGap = Math.max(0.08, eSide * 0.08);
  const clusterPitchX = 2 * eSide + eGap + gap * 1.6;
  const clusterPitchY = 2 * eSide + eGap + gap * 1.6;
  for (let i = 0; i < eCount; i += 1) {
    const cl = Math.floor(i / cluster);
    const local = i % cluster;
    boxes.push({
      id: `ecore-${i}`,
      role: "ecore",
      x: (cl % clusterCols) * clusterPitchX + (local % 2) * (eSide + eGap),
      y: pBottom + 0.42 + Math.floor(cl / clusterCols) * clusterPitchY + Math.floor(local / 2) * (eSide + eGap),
      w: eSide,
      h: eSide,
    });
  }
  const body = spanOf(boxes.length > 0 ? boxes : [{ id: "empty", role: "core", x: 0, y: 0, w: pSide, h: pSide }]);
  const usedW = Math.max(body.w, pSide, 1);
  const l3h = Math.max(floor.l3PerCore * Math.max(cores, 1), usedW * 0.4) / usedW;
  const l3y = (boxes.length > 0 ? body.h : 0) + 0.28;
  boxes.push({ id: "l3", role: "l3", x: 0, y: l3y, w: usedW, h: l3h });
  boxes.push({
    id: "iod",
    role: "iod",
    x: 0,
    y: l3y + l3h + 0.22,
    w: usedW,
    h: Math.max(1.05, floor.iodMm2 / usedW),
  });
  return boxes;
}

/**
 * GPU die in the GPC arrangement used since Pascal: SM pairs inside a GPC,
 * a gap between GPCs, an L2 slice on the crossbar, and GDDR/HBM PHYs on the
 * long edges. A tensor block is the MAC array inset in each SM, not extra silicon.
 */
function gpuBoxes(shaders: number, tensors: number, phyCount: number, floor: GpuFloor, drawTensor: boolean): Box[] {
  const smN = Math.max(1, Math.round(shaders / floor.shadersPerSm));
  const side = Math.sqrt(floor.smMm2);
  const gutter = side * 0.06;
  const gpcGap = side * 0.32;
  const smsPerGpc = smN >= 32 ? 8 : smN >= 8 ? 4 : Math.max(1, smN);
  const nGpc = Math.ceil(smN / smsPerGpc);
  const gpcCols = Math.max(1, Math.ceil(Math.sqrt(nGpc * 1.65)));
  const leftCols = Math.ceil(gpcCols / 2);
  const smCols = smsPerGpc >= 4 ? 2 : 1;
  const smRows = Math.ceil(smsPerGpc / smCols);
  const gpcW = smCols * side + Math.max(0, smCols - 1) * gutter;
  const gpcH = smRows * side + Math.max(0, smRows - 1) * gutter;
  const gpcRows = Math.ceil(nGpc / gpcCols);
  const l2w = Math.max(side * 0.42, gpcH * gpcRows * floor.l2Fraction * 0.22);
  const phyH = phyCount > 0 ? Math.max(0.42, side * 0.34) : 0;
  const top = phyH > 0 ? phyH + 0.18 : 0.1;
  const leftPad = 0.08;
  const boxes: Box[] = [];
  const originOf = (gpc: number): { x: number; y: number } => {
    const col = gpc % gpcCols;
    const row = Math.floor(gpc / gpcCols);
    const onRight = col >= leftCols;
    const local = onRight ? col - leftCols : col;
    return {
      x: leftPad + (onRight ? leftCols * (gpcW + gpcGap) + l2w + 0.16 : 0) + local * (gpcW + gpcGap),
      y: top + row * (gpcH + gpcGap),
    };
  };
  for (let i = 0; i < smN; i += 1) {
    const origin = originOf(Math.floor(i / smsPerGpc));
    const local = i % smsPerGpc;
    const x = origin.x + (local % smCols) * (side + gutter);
    const y = origin.y + Math.floor(local / smCols) * (side + gutter);
    boxes.push({ id: `sm-${i}`, role: "sm", x, y, w: side, h: side });
    if (drawTensor && tensors > 0) {
      boxes.push({
        id: `tensor-${i}`,
        role: "tensor",
        x: x + side * 0.1,
        y: y + side * 0.58,
        w: side * 0.8,
        h: side * 0.28,
      });
    }
  }
  const gridBottom = top + gpcRows * (gpcH + gpcGap) - gpcGap;
  boxes.push({
    id: "l2",
    role: "l2",
    x: leftPad + leftCols * (gpcW + gpcGap),
    y: top,
    w: l2w,
    h: Math.max(side, gridBottom - top),
  });
  if (phyCount > 0) {
    const contentW = Math.max(spanOf(boxes).w, side);
    const nTop = Math.ceil(phyCount / 2);
    const nBot = phyCount - nTop;
    const topPitch = contentW / nTop;
    for (let i = 0; i < nTop; i += 1) {
      boxes.push({
        id: `phy-t-${i}`,
        role: "phy",
        x: i * topPitch + 0.05,
        y: 0.04,
        w: Math.max(0.22, topPitch - 0.1),
        h: phyH,
      });
    }
    const botPitch = nBot > 0 ? contentW / nBot : contentW;
    for (let i = 0; i < nBot; i += 1) {
      boxes.push({
        id: `phy-b-${i}`,
        role: "phy",
        x: i * botPitch + 0.05,
        y: gridBottom + 0.16,
        w: Math.max(0.22, botPitch - 0.1),
        h: phyH,
      });
    }
  }
  return boxes;
}

/**
 * Circular-source constriction on bulk silicon.
 * \[ \Delta T = \frac{P}{4 k_{Si} a},\quad a = \sqrt{A/\pi} \]
 * \(\Delta T\) in [K], \(P\) in [W], \(k_{Si}\) in [W/m/K], \(a\) in [m].
 */
function constrictionK(powerW: number, areaMm2: number): number {
  if (powerW <= 0 || areaMm2 <= 0) return 0;
  const radiusM = Math.sqrt((areaMm2 * 1e-6) / Math.PI);
  return powerW / (4 * K_SILICON * radiusM);
}

function finishDie(boxes: readonly Box[], rawPower: readonly number[], targetW: number, hotspotC: number, ambientC: number): DieMap {
  const rawSum = rawPower.reduce((sum, value) => sum + value, 0);
  const scale = rawSum > 0 ? targetW / rawSum : 0;
  const powers = rawPower.map((value) => value * scale);
  const rises = boxes.map((box, index) => constrictionK(powers[index], box.w * box.h));
  const riseMax = rises.reduce((max, value) => Math.max(max, value), 0);
  const outline = spanOf(boxes);
  // The cooler already sets the hotspot. Lateral spreading in the die keeps
  // the coldest block within 62% of (Tj − Ta), so cache does not fall to ambient.
  const headroom = Math.max(0, hotspotC - ambientC);
  const contrast = riseMax > 0 ? Math.min(1, (0.62 * headroom) / riseMax) : 0;
  const smTemp = new Map<string, number>();
  const draft: DieBlock[] = boxes.map((box, index) => {
    const tempC = Math.max(ambientC, hotspotC - contrast * (riseMax - rises[index]));
    if (box.role === "sm") smTemp.set(box.id, tempC);
    return {
      id: box.id,
      role: box.role,
      x: outline.w > 0 ? box.x / outline.w : 0,
      y: outline.h > 0 ? box.y / outline.h : 0,
      w: outline.w > 0 ? box.w / outline.w : 0,
      h: outline.h > 0 ? box.h / outline.h : 0,
      areaMm2: box.w * box.h,
      areaNm2: box.w * box.h * 1e12,
      powerW: powers[index],
      tempC,
    };
  });
  // A tensor inset is the same silicon as its SM. An idle array sits at the
  // SM temperature; a switching array is already hotter by constriction.
  const blocks = draft.map((block) => {
    if (block.role !== "tensor") return block;
    const host = smTemp.get(`sm-${block.id.slice("tensor-".length)}`);
    return host === undefined ? block : { ...block, tempC: Math.max(block.tempC, host) };
  });
  const silicon = blocks.reduce((sum, block) => sum + (block.role === "tensor" ? 0 : block.areaMm2), 0);
  const watts = blocks.reduce((sum, block) => sum + block.powerW, 0);
  const temps = blocks.map((block) => block.tempC);
  return {
    widthMm: outline.w,
    heightMm: outline.h,
    widthNm: outline.w * 1e6,
    heightNm: outline.h * 1e6,
    areaMm2: silicon,
    areaNm2: silicon * 1e12,
    densityWPerMm2: silicon > 0 ? watts / silicon : 0,
    coolestC: temps.reduce((min, value) => Math.min(min, value), hotspotC),
    blocks,
  };
}

/**
 * CPU floorplan for the configured core count.
 * Chiplets are CCDs plus an I/O die. Monoliths put P-cores, optional E-cores,
 * a last-level cache, and the memory/PCIe strip on one piece of silicon.
 * Dynamic power follows core area. Cache and the I/O die take uncore, mesh, IMC, and the PCIe PHY.
 */
function cpuDieMap(
  arch: CpuArch,
  cores: number,
  threads: number,
  freqHz: number,
  load: number,
  packageFixedW: number,
  packageW: number,
  hotspotC: number,
  ambientC: number,
): DieMap {
  const floor = CPU_FLOOR[arch.id];
  const boxes = floor.style === "chiplet" ? chipletBoxes(cores, floor) : monolithBoxes(cores, floor);
  const dyn = cpuDynamicW(arch, cores, threads, freqHz, load);
  const leak = cpuLeakW(arch, cores, freqHz, hotspotC);
  const mesh = arch.meshWPerCore * cores * (freqHz / arch.fRefHz);
  const uncore = arch.uncoreW;
  const iodFixed = Math.max(0, packageFixedW - uncore - mesh);
  const coreBoxes = boxes.filter((box) => box.role === "core" || box.role === "ecore");
  const coreWeight = coreBoxes.reduce((sum, box) => {
    const area = box.w * box.h;
    return sum + (box.role === "ecore" ? area * 0.62 : area);
  }, 0);
  const l3Boxes = boxes.filter((box) => box.role === "l3");
  const l3Area = l3Boxes.reduce((sum, box) => sum + box.w * box.h, 0);
  const iodBudget = uncore * 0.4 + mesh * 0.55 + iodFixed;
  const l3Budget = uncore * 0.6 + mesh * 0.45;
  const raw = boxes.map((box) => {
    const area = box.w * box.h;
    if (box.role === "core") return coreWeight > 0 ? ((dyn + leak) * area) / coreWeight : 0;
    if (box.role === "ecore") return coreWeight > 0 ? ((dyn + leak) * area * 0.62) / coreWeight : 0;
    if (box.role === "l3") return l3Area > 0 ? (l3Budget * area) / l3Area : 0;
    if (box.role === "iod") return iodBudget;
    return 0;
  });
  return finishDie(boxes, raw, packageW, hotspotC, ambientC);
}

/**
 * GPU floorplan. GPCs hold SM pairs around an L2 crossbar slice.
 * Tensor cores are the MAC inset in each SM when the architecture has them.
 * GDDR or HBM PHYs line the long edges. The selected pipe gets the dynamic power.
 */
function gpuDieMap(
  arch: GpuArch,
  shaders: number,
  tensors: number,
  freqHz: number,
  format: Precision,
  load: number,
  endpointW: number,
  phyCount: number,
  packageW: number,
  hotspotC: number,
  ambientC: number,
): DieMap {
  const floor = GPU_FLOOR[arch.id];
  const tensorPipe = tensors > 0 && arch.tensor[format] !== undefined;
  const hasTensor = (Object.keys(arch.tensor) as Precision[]).some((key) => (arch.tensor[key] ?? 0) > 0);
  const boxes = gpuBoxes(shaders, tensors, phyCount, floor, hasTensor);
  const dyn = gpuDynamicW(arch, shaders, tensors, freqHz, format, load);
  const leak = gpuLeakW(arch, shaders, freqHz, hotspotC);
  const l2Budget = leak * 0.12;
  const smLeak = Math.max(0, leak - l2Budget);
  const smBoxes = boxes.filter((box) => box.role === "sm");
  const smArea = smBoxes.reduce((sum, box) => sum + box.w * box.h, 0);
  const tensorBoxes = boxes.filter((box) => box.role === "tensor");
  const tensorArea = tensorBoxes.reduce((sum, box) => sum + box.w * box.h, 0);
  const phys = boxes.filter((box) => box.role === "phy");
  const l2Boxes = boxes.filter((box) => box.role === "l2");
  const phyBudget = phys.length > 0 ? endpointW : 0;
  const l2Extra = phys.length > 0 ? 0 : endpointW;
  const raw = boxes.map((box) => {
    const area = box.w * box.h;
    if (box.role === "tensor") return tensorPipe && tensorArea > 0 ? (dyn * area) / tensorArea : 0;
    if (box.role === "sm") {
      const dynShare = tensorPipe || smArea <= 0 ? 0 : (dyn * area) / smArea;
      return dynShare + (smArea > 0 ? (smLeak * area) / smArea : 0);
    }
    if (box.role === "l2") return l2Boxes.length > 0 ? (l2Budget + l2Extra) / l2Boxes.length : 0;
    if (box.role === "phy") return phys.length > 0 ? phyBudget / phys.length : 0;
    return 0;
  });
  return finishDie(boxes, raw, packageW, hotspotC, ambientC);
}

function imcWatts(arch: CpuArch, channels: number, rateMt: number, load: number, trained: boolean): number {
  if (!trained) return channels * arch.imcBaseW * 0.35;
  return channels * (arch.imcBaseW + arch.imcPerGTs * (rateMt / 1000) * load);
}

/**
 * Solve one board.
 *
 * Link generation is the minimum of the request, the CPU PHY, the GPU PHY,
 * and the slot, unless `forceGen` is set. Forcing still has to pass the
 * loss mask. A failed train leaves the previous numbers off this report:
 * bandwidth is zero and the fault says why.
 */
export function evaluate(input: BenchConfig): BenchReport {
  const config = sanitize(input);
  const notes: string[] = [];
  const chipset = CHIPSETS[config.chipsetId];
  const cpuArch = CPU_ARCH[config.cpu.arch];
  const gpuArch = GPU_ARCH[config.gpu.arch];
  const dramSpec = DRAM_SPEC[config.dram.kind];
  const vramSpec = VRAM_SPEC[config.vram.kind];

  if (input.cpu.cores > CORE_MAX) notes.push(`Cores clamped to ${CORE_MAX}.`);
  if (input.cpu.threads > THREAD_MAX) notes.push(`Threads clamped to ${THREAD_MAX}.`);
  if (input.gpu.tensors > TENSOR_MAX) notes.push(`Tensor cores clamped to ${TENSOR_MAX}.`);
  if (input.dram.megaTransfers > dramSpec.rateMax || input.vram.megaTransfers > vramSpec.rateMax) {
    notes.push("Memory rate clamped to the format ceiling.");
  }
  if (input.dram.gb < DRAM_MIN_GB || input.vram.gb < VRAM_MIN_GB) {
    notes.push(`Capacity raised to the floor (${DRAM_MIN_GB} GB system, ${VRAM_MIN_GB} GB video).`);
  }
  if (config.cpu.ghz * 1e9 > cpuArch.fRatedHz + 1e6) notes.push(`${cpuArch.label} is above its rated clock.`);
  if (config.cpu.cores > cpuArch.ratedCores) notes.push(`${cpuArch.label} core count is an extrapolation past ${cpuArch.ratedCores}.`);
  if (config.gpu.ghz * 1e9 > gpuArch.fRatedHz + 1e6) notes.push(`${gpuArch.label} is above its rated clock.`);
  if (config.dram.kind === "ddr5" && config.dram.megaTransfers > 8400) {
    notes.push("DDR5 rate is above JEDEC 8400 and inside the bench ceiling.");
  }

  const ratedGen = earlier(earlier(cpuArch.ioGen, gpuArch.ioGen), chipset.pegGen);
  const attempted: PcieGen = config.forceGen ? config.requestedGen : earlier(config.requestedGen, ratedGen);
  const overSpec = PCIE_GENS.indexOf(attempted) > PCIE_GENS.indexOf(ratedGen);
  const lanes = chipset.pegLanes;
  const spec = PCIE[attempted];
  const ilDb = channelLossDb(spec.nyquistHz, chipset.traceCm, chipset.laminate);
  const needRetimers = requiredRetimers(ilDb, spec.budgetDb);
  const linkUp = needRetimers <= chipset.maxRetimers;
  const bytes = linkUp ? pcieBytesPerSec(attempted, lanes) : 0;
  const activeEndpoint = endpointWatts(attempted, lanes, ilDb / (needRetimers + 1));
  const endpointW = linkUp ? activeEndpoint : activeEndpoint * 0.15;
  const retimerW = linkUp ? retimerBankWatts(attempted, lanes, needRetimers) : 0;
  const baud = spec.modulation === "nrz" ? spec.gtPerSec * 1e9 : spec.gtPerSec * 0.5e9;
  const flight = (chipset.traceCm / 100) * Math.sqrt(LAMINATES[chipset.laminate].er) / C;
  const latencyS = linkUp ? flight + 4 / baud + needRetimers * 1e-9 : 0;

  let linkReason = `x16 ${attempted} trained.`;
  if (!linkUp) {
    linkReason = `x16 ${attempted} did not train. Channel ${ilDb.toFixed(1)} dB, mask ${spec.budgetDb.toFixed(0)} dB, board allows ${chipset.maxRetimers} retimer${chipset.maxRetimers === 1 ? "" : "s"} and the run needs ${needRetimers}.`;
  } else if (attempted !== config.requestedGen) {
    linkReason = `Requested ${config.requestedGen}, trained ${attempted}. Limited by ${cpuArch.label} / ${gpuArch.label} / ${chipset.label} (rated ${ratedGen}).`;
  } else if (overSpec) {
    linkReason = `x16 ${attempted} trained above the rated ${ratedGen} PHY.`;
  } else if (needRetimers > 0) {
    linkReason = `x16 ${attempted} trained with ${needRetimers} retimer${needRetimers === 1 ? "" : "s"}.`;
  }

  const dramTrained = dramLegal(chipset, cpuArch, config.dram.kind);
  const dramReason = dramTrained
    ? `${dramSpec.label} on ${chipset.label}.`
    : `${dramSpec.label} cannot train. ${chipset.label} accepts ${chipset.dram.join("/")} and ${cpuArch.label} accepts ${cpuArch.dram.join("/")}.`;
  const dramBus = chipset.memChannels * 64;
  const dramBw = dramTrained ? memoryBytesPerSec(config.dram.megaTransfers, dramBus) : 0;
  const dramW = dramTrained ? memoryWatts(dramSpec, dramBw, config.dram.gb, config.cpu.load) : 0;
  const imc = imcWatts(cpuArch, chipset.memChannels, config.dram.megaTransfers, config.cpu.load, dramTrained);

  const vramTrained = vramLegal(gpuArch, config.vram.kind, config.forceVram);
  const vramReason = vramTrained
    ? `${vramSpec.label}${config.forceVram && !gpuArch.vram.includes(config.vram.kind) ? " forced onto " + gpuArch.label : ""}.`
    : `${vramSpec.label} is not on ${gpuArch.label}. That PHY accepts ${gpuArch.vram.join("/")}.`;
  const vramBus = config.vram.kind === "hbm" ? config.vram.stacks * 1024 : config.vram.busBits;
  const vramBw = vramTrained ? memoryBytesPerSec(config.vram.megaTransfers, vramBus) : 0;
  const vramW = vramTrained ? memoryWatts(vramSpec, vramBw, config.vram.gb, config.gpu.load) : 0;

  const cpuFreq = config.cpu.ghz * 1e9;
  const gpuFreq = config.gpu.ghz * 1e9;
  const cpuCooler = COOLERS[config.cpuCooler];
  const gpuCooler = COOLERS[config.gpuCooler];

  const cpuFixed = cpuArch.uncoreW + coresMesh(cpuArch, config.cpu.cores, cpuFreq) + imc + endpointW;
  const cpuThermal = solvePackage(
    (tempC, scale) => cpuDynamicW(cpuArch, config.cpu.cores, config.cpu.threads, cpuFreq * scale, config.cpu.load)
      + cpuLeakW(cpuArch, config.cpu.cores, cpuFreq * scale, tempC)
      + cpuFixed,
    cpuCooler.cpuRth,
    config.ambientC,
    cpuArch.tMaxC,
  );

  const gpuThermal = solvePackage(
    (tempC, scale) => gpuDynamicW(gpuArch, config.gpu.shaders, config.gpu.tensors, gpuFreq * scale, config.gpu.format, config.gpu.load)
      + gpuLeakW(gpuArch, config.gpu.shaders, gpuFreq * scale, tempC)
      + vramW
      + endpointW,
    gpuCooler.gpuRth,
    config.ambientC,
    gpuArch.tMaxC,
  );

  const flop = cpuFlopPerSec(cpuArch, config.cpu.cores, config.cpu.threads, cpuFreq * cpuThermal.scale, config.cpu.load);
  const byFormat: FormatRow[] = PRECISIONS.map((format) => {
    const ops = gpuOpsPerSec(gpuArch, config.gpu.shaders, config.gpu.tensors, gpuFreq * gpuThermal.scale, format);
    return {
      format,
      opsPerSec: ops === null ? null : ops * config.gpu.load,
      unit: format === "int8" ? "TOP/s" : "TFLOP/s",
    };
  });
  const activeOps = gpuOpsPerSec(gpuArch, config.gpu.shaders, config.gpu.tensors, gpuFreq * gpuThermal.scale, config.gpu.format);
  const fanW = cpuCooler.fanW + gpuCooler.fanW;
  const cpuDie = cpuDieMap(
    cpuArch,
    config.cpu.cores,
    config.cpu.threads,
    cpuFreq * cpuThermal.scale,
    config.cpu.load,
    cpuFixed,
    cpuThermal.watts,
    cpuThermal.tempC,
    config.ambientC,
  );
  const gpuPhyCount = config.vram.kind === "hbm" ? config.vram.stacks : Math.max(1, Math.round(config.vram.busBits / 32));
  const gpuDie = gpuDieMap(
    gpuArch,
    config.gpu.shaders,
    config.gpu.tensors,
    gpuFreq * gpuThermal.scale,
    config.gpu.format,
    config.gpu.load,
    endpointW,
    vramTrained ? gpuPhyCount : 0,
    gpuThermal.watts - vramW,
    gpuThermal.tempC,
    config.ambientC,
  );
  // CPU package already includes one endpoint. The GPU endpoint is the matching second PHY.
  // The laser bank is a separate electrical load and becomes heat with everything else.
  const optical = solveOptical({
    config: config.optical,
    lengthCm: chipset.traceCm,
    ambientC: config.ambientC,
    cpuC: cpuThermal.tempC,
    gpuC: gpuThermal.tempC,
  });
  const electricalW = cpuThermal.watts + gpuThermal.watts + dramW + chipset.pchW + retimerW + fanW + optical.watts;
  const faults: Fault[] = [];
  if (!linkUp) faults.push({ domain: "link", reason: linkReason });
  if (!dramTrained) faults.push({ domain: "dram", reason: dramReason });
  if (!vramTrained) faults.push({ domain: "vram", reason: vramReason });
  if (config.optical.enabled && !optical.up) faults.push({ domain: "optical", reason: optical.reason });

  return {
    config,
    notes,
    chipset,
    cpuArch,
    gpuArch,
    link: {
      attempted,
      trained: linkUp ? attempted : null,
      lanes,
      up: linkUp,
      reason: linkReason,
      bytesPerSecEachWay: bytes,
      ilDb,
      budgetDb: spec.budgetDb,
      retimers: needRetimers,
      latencyS,
      endpointW,
      retimerW,
      nyquistHz: spec.nyquistHz,
    },
    dram: {
      trained: dramTrained,
      reason: dramReason,
      clockHz: (config.dram.megaTransfers * 1e6) / dramSpec.clockDivisor,
      channels: chipset.memChannels,
      bytesPerSec: dramBw,
      watts: dramW,
    },
    vram: {
      trained: vramTrained,
      reason: vramReason,
      clockHz: (config.vram.megaTransfers * 1e6) / vramSpec.clockDivisor,
      busBits: vramBus,
      stacks: config.vram.stacks,
      bytesPerSec: vramBw,
      watts: vramW,
    },
    cpu: {
      watts: cpuThermal.watts,
      junctionC: cpuThermal.tempC,
      tMaxC: cpuArch.tMaxC,
      scale: cpuThermal.scale,
      throttled: cpuThermal.throttled,
      runaway: cpuThermal.runaway,
      flopPerSecDp: flop,
      voltage: coreVoltage(cpuArch, cpuFreq * cpuThermal.scale),
      deliveredGhz: config.cpu.ghz * cpuThermal.scale,
      die: cpuDie,
    },
    gpu: {
      asicW: gpuThermal.watts - vramW - endpointW,
      junctionC: gpuThermal.tempC,
      tMaxC: gpuArch.tMaxC,
      scale: gpuThermal.scale,
      throttled: gpuThermal.throttled,
      runaway: gpuThermal.runaway,
      opsPerSec: activeOps === null ? null : activeOps * config.gpu.load,
      unit: config.gpu.format === "int8" ? "TOP/s" : "TFLOP/s",
      deliveredGhz: config.gpu.ghz * gpuThermal.scale,
      voltage: gpuVoltage(gpuArch, gpuFreq * gpuThermal.scale),
      byFormat,
      die: gpuDie,
    },
    pchW: chipset.pchW,
    fanW,
    optical,
    electricalW,
    heatW: electricalW,
    faults,
  };
}

function coresMesh(arch: CpuArch, cores: number, freqHz: number): number {
  return arch.meshWPerCore * cores * (freqHz / arch.fRefHz);
}

export type Preset = { id: string; label: string; detail: string; config: BenchConfig };

/**
 * Each preset is a machine whose parts shipped together, named for its memory
 * generation and year. The last one is a projection: PCIe 7.0 hardware does not
 * exist yet, so it is built from the newest parts in the tables.
 */
export const PRESETS: readonly Preset[] = [
  {
    id: "ddr2",
    label: "DDR2 · 2007",
    detail: "nForce 520 · Gen1 · 8800 GTS",
    config: {
      // The 25 cm run on this board loses 19 dB, so the optical lanes run at PCIe 1.0's 2.5 Gbit/s line rate to keep the eye open.
      chipsetId: "nf520", requestedGen: "1.0", forceGen: false, forceVram: false, optical: { ...DEFAULT_OPTICAL, gbitPerLane: 2.5 },
      cpu: { arch: "legacy", cores: 2, threads: 2, ghz: 2.7, load: 1 },
      gpu: { arch: "tesla", shaders: 128, tensors: 0, ghz: 1.625, format: "fp32", load: 1 },
      dram: { kind: "ddr2", gb: 2, megaTransfers: 800 },
      vram: { kind: "gddr3", gb: 0.5, megaTransfers: 1940, busBits: 256, stacks: 1 },
      cpuCooler: "air", gpuCooler: "air", ambientC: 25,
    },
  },
  {
    id: "ddr3",
    label: "DDR3 · 2012",
    detail: "Z77 · Gen3 · GTX 680",
    config: {
      chipsetId: "z77", requestedGen: "3.0", forceGen: false, forceVram: false, optical: { ...DEFAULT_OPTICAL },
      cpu: { arch: "ivy", cores: 4, threads: 8, ghz: 3.5, load: 1 },
      gpu: { arch: "kepler", shaders: 1536, tensors: 0, ghz: 1.058, format: "fp32", load: 1 },
      dram: { kind: "ddr3", gb: 16, megaTransfers: 1600 },
      vram: { kind: "gddr5", gb: 2, megaTransfers: 6000, busBits: 256, stacks: 1 },
      cpuCooler: "air", gpuCooler: "air", ambientC: 25,
    },
  },
  {
    id: "ddr4",
    label: "DDR4 · 2022",
    detail: "B660 · Gen4 · RTX 3070 Ti",
    config: {
      chipsetId: "b660", requestedGen: "4.0", forceGen: false, forceVram: false, optical: { ...DEFAULT_OPTICAL },
      cpu: { arch: "raptor", cores: 8, threads: 16, ghz: 4.8, load: 1 },
      gpu: { arch: "ampere", shaders: 6144, tensors: 192, ghz: 1.77, format: "fp32", load: 1 },
      dram: { kind: "ddr4", gb: 32, megaTransfers: 3200 },
      vram: { kind: "gddr6x", gb: 8, megaTransfers: 19000, busBits: 256, stacks: 1 },
      cpuCooler: "aio240", gpuCooler: "air", ambientC: 25,
    },
  },
  {
    id: "ddr5",
    label: "DDR5 · 2025",
    detail: "X670E · Gen5 · RTX 5090",
    config: {
      chipsetId: "x670e", requestedGen: "5.0", forceGen: false, forceVram: false, optical: { ...DEFAULT_OPTICAL },
      cpu: { arch: "zen5", cores: 16, threads: 32, ghz: 5, load: 1 },
      gpu: { arch: "blackwell", shaders: 21760, tensors: 680, ghz: 2.41, format: "fp32", load: 1 },
      dram: { kind: "ddr5", gb: 64, megaTransfers: 6000 },
      vram: { kind: "gddr7", gb: 32, megaTransfers: 28000, busBits: 512, stacks: 1 },
      cpuCooler: "aio360", gpuCooler: "aio360", ambientC: 25,
    },
  },
  {
    id: "arrow",
    label: "Arrow · 2025",
    detail: "Z890 · Gen5 · RTX 5080",
    config: {
      chipsetId: "z890", requestedGen: "5.0", forceGen: false, forceVram: false, optical: { ...DEFAULT_OPTICAL },
      cpu: { arch: "arrow", cores: 24, threads: 24, ghz: 5, load: 1 },
      gpu: { arch: "blackwell", shaders: 10752, tensors: 336, ghz: 2.62, format: "fp32", load: 1 },
      dram: { kind: "ddr5", gb: 48, megaTransfers: 6400 },
      vram: { kind: "gddr7", gb: 16, megaTransfers: 30000, busBits: 256, stacks: 1 },
      cpuCooler: "aio360", gpuCooler: "air", ambientC: 25,
    },
  },
  {
    id: "storm",
    label: "96c · 2023",
    detail: "WRX90 · 96 cores · H100",
    config: {
      chipsetId: "wrx90", requestedGen: "5.0", forceGen: false, forceVram: false, optical: { ...DEFAULT_OPTICAL },
      cpu: { arch: "storm", cores: 96, threads: 192, ghz: 2.5, load: 1 },
      gpu: { arch: "hopper", shaders: 14592, tensors: 456, ghz: 1.755, format: "fp16", load: 1 },
      dram: { kind: "ddr5", gb: 256, megaTransfers: 5200 },
      vram: { kind: "hbm", gb: 80, megaTransfers: 3200, busBits: 256, stacks: 5 },
      cpuCooler: "loop", gpuCooler: "loop", ambientC: 25,
    },
  },
  {
    id: "gen7",
    label: "Gen7 · 2027+",
    detail: "projected · Megtron · 1 retimer",
    config: {
      chipsetId: "wrx90", requestedGen: "7.0", forceGen: true, forceVram: false, optical: { ...DEFAULT_OPTICAL },
      cpu: { arch: "zen5", cores: 16, threads: 32, ghz: 4.6, load: 1 },
      gpu: { arch: "halo", shaders: 12288, tensors: 1024, ghz: 2.2, format: "fp8", load: 1 },
      dram: { kind: "ddr5", gb: 64, megaTransfers: 7200 },
      vram: { kind: "gddr7", gb: 32, megaTransfers: 28000, busBits: 512, stacks: 1 },
      cpuCooler: "aio360", gpuCooler: "aio360", ambientC: 25,
    },
  },
];

export const DEFAULT_PRESET = PRESETS[3];
