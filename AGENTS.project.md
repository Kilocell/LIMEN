# LIMEN: instructions for coding agents

LIMEN (A Link Investigator for a Motherboard's Electro-optic Near-reach) is a single-page React 19 / TanStack Start / Vite 8 / Tailwind 4 dashboard. It draws a motherboard (CPU die, GPU die, x16 copper link, polymer waveguide with two SiN rings and an MZI, driven by an electro-optic Mach-Zehnder modulator) and solves it live in the browser. There is no backend, database, account, Python or notebook. Do not add any of these.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/limen.ts` | The whole physical model: copper channel, optical cascade, eye, frontier sweep, dies, thermal solve, chipset/CPU/GPU/memory tables, presets, `sanitize`, `evaluate` |
| `src/components/dashboard.tsx` | The page: board SVG, readouts, dock controls, four phase charts |
| `src/lib/assess.ts` | Status classes: `assess(report, frontier, verdict?)` returns stability, efficiency and overall ratings per medium, plus findings. Pure, no drawing |
| `src/lib/sensitivity.ts` | The ±25 % sweep over the assumed constants (`sensitivity`, `sensitivityAsync`) and its verdict |
| `src/lib/report.ts` | Markdown, JSON (`REPORT_SCHEMA`) and CSV export. Pure string builders |
| `src/components/status-panel.tsx` | The Status, Sensitivity and Report blocks of the page |
| `src/styles.css` | All styling (Tailwind 4 `@theme` tokens plus plain CSS classes) |
| `src/lib/format.ts` | Number formatting (`sci`) |
| `tests/limen.test.ts`, `tests/status.test.ts` | Model tests (clean presets, finite numbers, energy balance, loss masks, pinned crossovers) and tests of the status classes, the sensitivity sweep and the report export |
| `docs/sources.md` | Where each datasheet value came from, and which constants are assumed. Update it when you change a preset or a constant |
| `.github/workflows/ci.yml` | Runs `npm test` and `npm run build` on every push to `main` and every pull request |
| `src/lib/error-component.tsx`, `src/routes/`, `src/router.tsx` | Error fallback and TanStack routing. `src/routeTree.gen.ts` is generated and git-ignored |

The model returns plain data from `evaluate(config)`. The dashboard only reads that report and draws it. Keep physics out of the components and drawing out of the model.

## Commands

```bash
npm install
npm run dev       # http://localhost:5173/
npm run build     # production bundle (Nitro, vercel preset)
npm run preview   # serves the build on http://localhost:3000/
```

`npm test` runs the model tests in `tests/` with Node's built-in runner (no test framework). There is no linter or formatter in the repo, and no TypeScript compiler in `package.json`. Do not add them unless asked. `@types/react` and `@types/react-dom` are dev dependencies. To typecheck, install the compiler temporarily and do not save it:

```bash
npm i --no-save typescript
npx tsc --ignoreConfig --noEmit --strict --jsx preserve --module esnext --moduleResolution bundler --target es2022 --skipLibCheck src/lib/limen.ts
```

That checks the model alone. For the whole `src/` tree (which needs the `@/*` path alias), use a throwaway tsconfig outside the repo. Never commit `node_modules` changes, `.vercel/`, `.tanstack/` or `routeTree.gen.ts`.

## Code standards

- **Complete code.** No placeholders, TODO stubs, commented-out code or truncated logic. Every change must run as written.
- **Strict TypeScript.** No `any`, no non-null assertions to silence errors. Prefer `as const` tables and literal-union types, as the existing `CHIPSETS`, `CPU_ARCH` and `PCIE_GENS` do.
- **Pure functions in the model.** Model functions take inputs and return values. No hidden global state, no mutation of arguments. The only module-level state is a few small caches (copper rows, optical eyes, pulse shapes, modulator operating points), each keyed by its inputs. Keep it that way.
- **Units in names and comments.** SI inside the model. Name units in the identifier (`fRefHz`, `lengthCm`, `tempC`, `energyPj`, `ilDb`) or in a bracketed doc comment such as `[dB]`, `[W]`, `[K/W]`. State the governing equation in the comment when you add a formula.
- **Deterministic.** The eye records use the seeded `mulberry32(1)`. Never call `Math.random()` or `Date.now()` in the model or during render. The same config must give the same numbers.
- **Numerically safe.** `clamp` handles NaN. Anything that can diverge (thermal fixed point, bisection, log of a small number) needs an explicit finite check and a defined result, as `solvePackage` does for runaway. All of a report's numbers must be finite for every config that `sanitize` allows.
- **Simple comments.** Explain why, not what. Short, plain language. Rewrite a comment when you change the code under it.
- **No layering on old code.** When a function or file is obsolete or wrong, rewrite or delete it. Do not wrap, shim or extend it, and do not leave dead code, unused exports, unused CSS classes or unused attributes behind.

## Model rules that must keep holding

- Ring circumference is 503 µm (radius 80.1 µm), above the 80 µm bend limit. Do not shrink it.
- Couplers are lossy (`COUPLER_EXCESS_DB`), including the tap. Do not model one as lossless.
- The frontier sweep (`solveFrontier`, 2 to 60 cm) solves the link at every length. Do not anchor on a fixed reference Q.
- PAM4 eye records are at least `PAM4_MIN_SYMBOLS` (256) symbols.
- Copper and optical are compared on one basis: both pay `phyJPerBit` (copper for the whole channel, the optical lane for its short die-to-engine hop), both use the generation's loss mask from `PCIE`, and both are held to `berTarget` (1e-12 NRZ, 1e-6 PAM4 before FEC). Do not give one side a private constant.
- The optical receiver is a one-pole filter at `rxBwFrac` of the symbol rate. Do not read the eye from unfiltered samples.
- An assumed constant lives in the `ASSUMPTIONS` registry in `limen.ts` and is read through `assumed(key)`, never as a bare number in the physics, so `withAssumptions` can scale it. Add each new one to the registry, to `docs/sources.md` and to the sensitivity plan. `withAssumptions` clears the eye, copper-row and modulator caches because their keys leave the constants out; any new cache must be cleared there too.
- Status thresholds (`STABILITY_RATIO`, `LOSS_MARGIN_SHARE`, `EFFICIENCY_PJ` in `assess.ts`) are chosen for this model's range and pinned by `tests/status.test.ts`. If you move one on purpose, update the snapshot and say why in the commit.
- Library files import each other with the `.ts` extension (`"./limen.ts"`), because `npm test` runs them directly under Node. `tsconfig.json` allows that with `allowImportingTsExtensions`.
- Material numbers are representative, not foundry data. Keep that said in the README and do not present results as measured.
- Each memory format has its own rate ceiling (`rateMax` in `DRAM_SPEC` and `VRAM_SPEC`). Cores are capped at 256 and threads at 512. `sanitize` is the single place that clamps configs.
- Every preset must be a machine whose parts shipped together, with no fault, no note and no throttling in `evaluate`. Check its memory bandwidth, core count, clocks, PCIe generation and board power against the vendor datasheet for the real product before you add or change one, and keep the era in its label true for every part.

## React and SSR rules

The page is server-rendered by TanStack Start and then hydrated. These have each caused a real bug here:

- Give `<title>` exactly one string child. A multi-child `<title>` renders empty on the server and breaks hydration.
- Never put a raw floating-point result into a DOM attribute. Node and Chrome can differ in the last bit. Quantise it first (`toFixed`) as the eye polyline does.
- Keep render pure: no `Math.random()`, `Date.now()`, `window` or `localStorage` outside effects.
- The live status text is debounced so screen readers are not flooded while a slider moves. Keep that behaviour.

## Accessibility and UI

- Everything on the board that can be clicked must also work from the keyboard: `role="button"`, `tabIndex`, Enter and Space, `aria-pressed`, `aria-label`.
- Keep the visible focus ring (`outline: 2px solid var(--color-sin)`).
- Segmented buttons carry `aria-pressed`. Charts carry `role="img"` and an `aria-label`.
- Colours come from the `@theme` tokens in `styles.css`. Do not hard-code new palette values in components.
- The desktop layout (≥1100 px) fits one screen with no page scroll. Check that after any layout change, and check a narrow phone width too.

## Verify before you finish

After writing code, re-read it for missing imports, unused variables, unreachable branches, infinite loops and off-by-one errors, then run:

1. The strict typecheck above, with no errors and no unused locals.
2. `npm run build`, then `npm run preview`.
3. Load the page in a real browser at 1440×900 and a phone width. The console must show no errors or warnings, and no "hydration" messages.
4. For model changes, run `npm test`. It sweeps every preset and a random spread of edits (all chipsets, CPUs, GPUs, memories, both bands, both coolers, extreme sliders), asserts that every number in `evaluate` is finite and that `heatW` equals `electricalW`, and pins the crossover results. If a change moves a pinned crossover on purpose, update the snapshot in `tests/limen.test.ts` and say why in the commit. `tests/status.test.ts` pins the status classes and sensitivity verdicts per preset and checks the report exports; a new analysis or export needs a test there. Add a test when you fix a bug.
5. For UI changes, tab through the board and the dock, and confirm focus, `aria-pressed` and the status text behave.

## Git

Make small commits, one concern each, with a plain message that says what changed and why. Each commit must typecheck on its own. Do not merge to `main` unless the user asks.
