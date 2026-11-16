# LIMEN

LIMEN is a Link Investigator for a Motherboard's Electro-optic Near-reach. The page draws a motherboard: CPU and GPU dies in nanometres, an x16 copper link, and a polymer waveguide into two silicon-nitride rings and an MZI, fed by an electro-optic Mach-Zehnder modulator. Everything is calculated in the browser by `src/lib/limen.ts`. There is no server calculation, database, or account.

LIMEN is a simulator, not a measurement instrument, and its numbers count as educated assumptions until you replace them with your own data.

**Connection status.** The page rates the whole link, and copper and optical separately, on two axes: *stability* (Robust, Stable, Thin margin, Unreliable, Down), from how far the eye's Q sits above the Q the BER target needs, and *efficiency* (Frugal, Efficient, Costly, Wasteful), from the energy in pJ/bit. In the **Sensitivity and report** block, **Run sensitivity** recalculates the model with each assumed constant 25 % lower and 25 % higher and says whether the board is robust, sensitive or fragile. The same block downloads the result as Markdown, JSON or a CSV of the 2 to 60 cm sweep, with the sensitivity included if you have run it. The efficiency limits are chosen for this model's range, not taken from a standard. The tables below give the details.

*Investigador de enlace para el alcance cercano electro-óptico de una placa madre. Todo el cálculo ocurre en tu navegador; no hay servidor, base de datos ni cuentas.*

LIMEN es un simulador, no un instrumento de medición, y sus números cuentan como aproximaciones hasta que los reemplaces con tus propios datos.

**Estado de la conexión.** La página califica el enlace completo, y el cobre y la óptica por separado, en dos ejes: *estabilidad* (Robust, Stable, Thin margin, Unreliable, Down: robusto, estable, margen justo, poco fiable, caído), según cuánto supera la Q del ojo a la Q que exige el objetivo de BER, y *eficiencia* (Frugal, Efficient, Costly, Wasteful: frugal, eficiente, costoso, derrochador), según los pJ/bit. En el bloque **Sensitivity and report**, **Run sensitivity** vuelve a calcular el modelo con cada constante supuesta 25 % más baja y 25 % más alta, y dice si la placa es robusta, sensible o frágil. El mismo bloque descarga el resultado en Markdown, JSON o CSV (el barrido de 2 a 60 cm), e incluye la sensibilidad si ya la ejecutaste. Los límites de eficiencia están elegidos para el rango de este modelo y no vienen de ningún estándar. Las tablas de abajo, en inglés, dan el detalle. La interfaz está solo en inglés.

- [Run it (English)](#run-it-english)
- [Cómo ejecutarlo (Español)](#cómo-ejecutarlo-español)
- [What you should see](#what-you-should-see)
- [Presets](#presets)
- [Model assumptions](#model-assumptions)
- [Where the code is](#where-the-code-is)
- [License](#license)

---

## Run it (English)

### 1. Install the two things you need (once)

| Tool | Version | Download |
| --- | --- | --- |
| Node.js (includes `npm`) | 22.12 or newer | <https://nodejs.org/> (pick the "LTS" button) |
| Git | any recent | <https://git-scm.com/downloads> (optional, see the ZIP option below) |

Check them. Open a terminal (Windows: *PowerShell* or *Windows Terminal*; macOS: *Terminal*; Linux: any terminal) and type each line, then press Enter:

```bash
node -v
npm -v
git --version
```

`node -v` must print `v22.12.0` or higher (`v23`, `v24` and so on also work). If it prints a lower number or "command not found", install Node.js again and open a **new** terminal window.

### 2. Get the code

With Git:

```bash
git clone https://github.com/Kilocell/LIMEN.git
cd LIMEN
```

Without Git: on the repository page press **Code → Download ZIP**, unzip it, open a terminal inside the unzipped folder (the one that contains `package.json`).

### 3. Install the dependencies (once, about a minute)

```bash
npm install
```

This creates a `node_modules` folder. Warnings are normal; red `npm error` lines are not (see Troubleshooting).

### 4. Start it

```bash
npm run dev
```

The terminal prints something like `Local: http://localhost:5173/`. Open that address in your browser. The page loads with the DDR5 / X670E board already solved. Leave the terminal open while you use it. **Stop it with `Ctrl+C`** in the terminal.

### 5. Optional: run the production build

```bash
npm run build
npm run preview
```

`npm run build` must finish first. Then open the address `preview` prints (normally <http://localhost:3000/>). Use this to check what a deployed copy would do.

### Other things you can do

| I want to... | Command |
| --- | --- |
| Open it from my phone on the same Wi-Fi | `npm run dev -- --host`, then open the `Network:` address it prints |
| Use a different port | `npm run dev -- --port 4000` |
| Run the tests (presets, finite numbers, crossover results, status classes, sensitivity, report export) | `npm test` |
| Start from a clean slate | Delete `node_modules`, then `npm install` again |

### Troubleshooting

- **`node` or `npm` is "not recognized" / "command not found".** Node.js is not installed or the terminal was opened before installing it. Install it, close the terminal, open a new one.
- **`npm run dev` says "Missing script" or `package.json` not found.** You are in the wrong folder. Run `ls` (macOS/Linux) or `dir` (Windows); you must see `package.json`. Use `cd LIMEN` to enter the folder.
- **Port already in use.** Vite picks the next free port and prints it. Use the address it prints, not `5173` from memory.
- **`npm install` fails with `EACCES` or permission errors.** Do not use `sudo`. Fix the folder permissions or clone into a folder you own (your home directory).
- **The page is blank or stale.** Hard-refresh (`Ctrl+Shift+R`, or `Cmd+Shift+R` on macOS). If it persists, stop the server and start it again.
- **Fonts look different offline.** The page loads IBM Plex from Google Fonts. Without a connection it falls back to your system fonts; nothing else changes.

---

## Cómo ejecutarlo (Español)

### 1. Instala lo necesario (una sola vez)

| Herramienta | Versión | Descarga |
| --- | --- | --- |
| Node.js (incluye `npm`) | 22.12 o superior | <https://nodejs.org/> (botón "LTS") |
| Git | cualquiera reciente | <https://git-scm.com/downloads> (opcional, mira la opción ZIP más abajo) |

Verifícalo. Abre una terminal (Windows: *PowerShell* o *Terminal de Windows*; macOS: *Terminal*; Linux: cualquier terminal), escribe cada línea y presiona Enter:

```bash
node -v
npm -v
git --version
```

`node -v` debe mostrar `v22.12.0` o más (`v23`, `v24`, etc. también sirven). Si muestra un número menor o "no se reconoce el comando", vuelve a instalar Node.js y abre una terminal **nueva**.

### 2. Descarga el código

Con Git:

```bash
git clone https://github.com/Kilocell/LIMEN.git
cd LIMEN
```

Sin Git: en la página del repositorio presiona **Code → Download ZIP**, descomprime el archivo y abre una terminal dentro de la carpeta descomprimida (la que contiene `package.json`).

### 3. Instala las dependencias (una sola vez, cerca de un minuto)

```bash
npm install
```

Se crea una carpeta `node_modules`. Las advertencias (*warnings*) son normales; las líneas rojas `npm error` no (revisa "Problemas comunes").

### 4. Inícialo

```bash
npm run dev
```

La terminal muestra algo como `Local: http://localhost:5173/`. Abre esa dirección en tu navegador. La página carga con la placa DDR5 / X670E ya calculada. Deja la terminal abierta mientras lo usas. **Para detenerlo presiona `Ctrl+C`** en la terminal.

### 5. Opcional: versión de producción

```bash
npm run build
npm run preview
```

Primero debe terminar `npm run build`. Luego abre la dirección que imprime `preview` (normalmente <http://localhost:3000/>). Sirve para ver cómo se comportaría una copia publicada.

### Otras cosas útiles

| Quiero... | Comando |
| --- | --- |
| Abrirlo desde mi celular en el mismo Wi-Fi | `npm run dev -- --host` y abre la dirección `Network:` que aparece |
| Ejecutar las pruebas (presets, números finitos, cruces, clases de estado, sensibilidad, exportación de reportes) | `npm test` |
| Usar otro puerto | `npm run dev -- --port 4000` |
| Empezar de cero | Borra `node_modules` y vuelve a ejecutar `npm install` |

### Problemas comunes

- **`node` o `npm` "no se reconoce" / "command not found".** Node.js no está instalado, o abriste la terminal antes de instalarlo. Instálalo, cierra la terminal y abre otra.
- **`npm run dev` dice "Missing script" o no encuentra `package.json`.** Estás en la carpeta equivocada. Ejecuta `ls` (macOS/Linux) o `dir` (Windows); debes ver `package.json`. Entra con `cd LIMEN`.
- **El puerto ya está ocupado.** Vite usa el siguiente puerto libre y lo imprime. Usa la dirección que aparece, no el `5173` de memoria.
- **`npm install` falla con `EACCES` o errores de permisos.** No uses `sudo`. Corrige los permisos de la carpeta o clona dentro de una carpeta tuya (tu directorio personal).
- **La página sale en blanco o desactualizada.** Recarga forzada (`Ctrl+Shift+R`, o `Cmd+Shift+R` en macOS). Si sigue igual, detén el servidor (`Ctrl+C`) y vuelve a iniciarlo.
- **Las tipografías se ven distintas sin internet.** La página carga IBM Plex desde Google Fonts. Sin conexión usa las fuentes del sistema; nada más cambia.

---

## What you should see

- A motherboard with a CPU die and a GPU die. Extents are labelled in nanometres.
- An x16 copper link and a polymer waveguide. The optical link reads **up** on the default X670E board.
- Heat on the dies. The header button turns the overlay off.
- A **Modulator** readout under the eye: material, section length, Vπ, drive swing, extinction ratio, insertion loss, bandwidth, drive energy and the laser power each lane needs.
- Below the readout: the C-band spectrum, the ring drift, NRZ and PAM4 eyes, and the length where the optical link uses less energy than copper.
- A **status chip** in the header and a **Status** block with a class for the whole connection, and for copper and optical separately: *stability* (Robust, Stable, Thin margin, Unreliable, Down) and *efficiency* (Frugal, Efficient, Costly, Wasteful). A **Sensitivity and report** block has a **Run sensitivity** button, which reruns the model with each assumed constant 25 % lower and higher and says whether the board is robust, sensitive or fragile, and three buttons that download the result as Markdown, JSON or a CSV of the 2 to 60 cm sweep. The report includes the sensitivity results once you have run it.

### How the status classes are set

| Class | Stability: Q against the Q that reaches the BER target | Efficiency: energy per bit |
| --- | --- | --- |
| Excellent | 1.4 times the target or more | 6 pJ/bit or less |
| Good | 1.2 times or more | up to 10 pJ/bit |
| Fair | 1.05 times or more | up to 16 pJ/bit |
| Poor | below 1.05 times | above 16 pJ/bit |
| Down | the link or the optical eye is not up | |

A channel with little loss margin left under its generation's mask is held to *Thin margin* at best for stability, but never below it while it is inside the mask. A laser at its limit, or a link that trained below the requested generation, also caps stability. The overall class of a medium is 65 % stability and 35 % efficiency, and the board's class is that of its best working medium. The efficiency limits are chosen for this model's range, not taken from a standard. The report notes the same, and says it is not a measurement instrument.

The dock swaps the chipset, PCIe generation, CPU, GPU, DRAM, VRAM, coolers, and the optical lanes (including the modulator material, length and drive voltage). Nothing is saved. Refreshing the page returns the default DDR5 preset.

## Presets

Each preset is a machine whose parts shipped together, named for its memory generation and year. Memory bandwidth, core counts, shader counts and board power are close to the published figures for those parts, and every preset trains its link at the requested speed with no fault, throttling or runaway.

| Preset | Board | CPU | GPU | Memory |
| --- | --- | --- | --- | --- |
| DDR2 · 2007 | nForce 520, PCIe 1.0 | Athlon 64 X2 class, 2 cores, 2.7 GHz, 65 nm | GeForce 8800 GTS 512 (G92), 128 shaders | 2 GB DDR2-800, 512 MB GDDR3 on 256 bit |
| DDR3 · 2012 | Z77, PCIe 3.0 | Ivy Bridge, 4 cores / 8 threads, 3.5 GHz | GeForce GTX 680 (Kepler), 1536 shaders | 16 GB DDR3-1600, 2 GB GDDR5 on 256 bit |
| DDR4 · 2022 | B660, PCIe 4.0 | Raptor Cove, 8 cores / 16 threads (the P-cores of a hybrid part) | RTX 3070 Ti (Ampere), 6144 shaders | 32 GB DDR4-3200, 8 GB GDDR6X on 256 bit |
| DDR5 · 2025 | X670E, PCIe 5.0 | Zen 5, 16 cores / 32 threads | RTX 5090 (Blackwell), 21760 shaders | 64 GB DDR5-6000, 32 GB GDDR7 on 512 bit |
| Arrow · 2025 | Z890, PCIe 5.0 | Arrow Lake, 24 cores / 24 threads (no Hyper-Threading) | RTX 5080 (Blackwell), 10752 shaders | 48 GB DDR5-6400, 16 GB GDDR7 on 256 bit |
| 96c · 2023 | WRX90, PCIe 5.0 | Zen 4 Storm Peak, 96 cores / 192 threads | H100 PCIe (Hopper), 14592 shaders | 256 GB DDR5-5200 on 8 channels, 80 GB HBM2e |
| Gen7 · 2027+ | WRX90, PCIe 7.0 forced, 1 retimer | Zen 5, 16 cores | A projected 3 nm part | 64 GB DDR5-7200, 32 GB GDDR7 |

The last preset is a projection: no PCIe 7.0 hardware exists yet, so it forces the link above what the board and chips are rated for. The optical lanes on the 2007 board run at 2.5 Gbit/s, PCIe 1.0's line rate, instead of 32, because its 25 cm run loses 19 dB and a faster eye would not open.

The presets are checked against vendor datasheets for core and shader counts, clocks, memory type and rate, bus width, PCIe generation and TDP. The model draws a typical full load, not the power limit, so a card's modelled board power sits up to 15 % below its rated figure (RTX 3070 Ti 248 W against 290 W, RTX 5080 330 W against 360 W, H100 322 W against 350 W) and the RTX 5090 sits level with its 575 W. The H100's 80 GB of HBM2e is modelled at 3.2 Gbit/s per pin, which gives 2048 GB/s against NVIDIA's "over 2,000".

## Model assumptions

The material numbers (effective and group index, loss, bend loss, thermo-optic coefficient) are representative literature-style values, not measurements from a foundry process. Replace them with your process data before trusting an absolute number.

- **PCIe 1.0 and 2.0.** These use 8b/10b line coding, so only 80 % of the line rate is payload.
- **Channel masks.** The copper channel must stay inside the generation's whole-channel insertion-loss mask at the Nyquist frequency: 13 dB (Gen 1), 17 dB (Gen 2), 22 dB (Gen 3), 28 dB (Gen 4), 36 dB (Gen 5), 32 dB (Gen 6) and 36 dB (Gen 7). Gen 1 follows a 2004 PCI-SIG deck (13.2 dB, the ratio of the minimum driver swing to the minimum receiver input). Gen 3 to 6 match the PCI-SIG budgets quoted in vendor and PCI-SIG material. Gen 7 follows Synopsys and trade-journal reports, including one from after the release; the members-only specification itself was not read, so it may differ. Gen 2 is not confirmed: one secondary source gives 12 dB, and only a Gen 2 board you build yourself uses it. The board's fixture (package, via and connector) adds loss on top of the trace: `1.25 · (f / 1 GHz)^0.9` dB.
- **Modulator.** The silicon-nitride rings have almost no electro-optic effect (they are tuned by heat), so the transmit modulator is a separate push-pull Mach-Zehnder on each lane, biased at quadrature. Light follows `P = P_laser · T · (1 + (1 − ε) · sin(π · V / Vπ)) / 2` with `V` the drive, `T` the insertion loss and `ε` the residual that sets the static extinction. Consequences you can see in the page:
  - Driving below Vπ shrinks the swing, so extinction ratio and eye height fall. The drive is capped at Vπ.
  - The sine curve compresses the outer PAM4 levels.
  - A one-pole travelling-wave bandwidth, `BW·L / L`, filters the drive before the light is formed, so long sections are slow.
  - Drive energy is `C · V² / 4` per bit, so long sections trade lower Vπ against more capacitance, loss and delay.
  - Silicon (carrier depletion) is lossy and needs a long section; thin-film lithium niobate is low-loss and fast; electro-optic polymer needs the least voltage. Electro-optic polymers lose their poling at high temperature, which the model does not track.
- **Wavelength.** Both waveguide platforms are designed for 1550 nm. The page keeps an optional O-band (1310 nm) mode, but the O-band cannot drive the 1550 nm ring.
- **Energy per bit.** Copper and optical energy are counted the same way. Both pay a PHY, the serialiser, equaliser and clocking, whose energy per bit is `E_serdes · (0.25 + 0.75 · loss / mask) + E_fec`. Copper pays it for the full channel, trace and fixture. The optical lane pays it for a short electrical hop from each die to its optical engine, which sees two thirds of the fixture loss (`phyFixedShare`, `opticalFixtureShare`). The optical lane then adds the laser, the modulator drive and the receiver.
- **Receiver bandwidth.** The photodiode and transimpedance amplifier are a one-pole filter at 0.7 of the symbol rate (`rxBwFrac`), with the matching noise bandwidth. Faster lanes therefore lose eye height to inter-symbol interference as well as to noise, and the lane rate cannot go below 2.5 Gbit/s.
- **Laser power.** The laser is sized per lane so the modulator launches 1 mW at its on level, up to a 20 mW limit. A lossy or under-driven modulator therefore costs wall-plug watts first (10 % efficiency, shared laser still pays for every lane) and eye height only once the laser runs out.
- **Ring size.** The silicon-nitride ring is 503 µm around (radius 80.1 µm), just above an 80 µm bend limit. At that size the free spectral range is only 2.3 nm, so each ring coupler is set to 70 % power coupling to keep a roughly 80 GHz drop passband, wider than the 32 Gbaud symbol rate.
- **Coupler loss.** Directional couplers are not lossless. Each has 0.1 dB of excess loss on top of its power split (`COUPLER_EXCESS_DB`), so a tap passes `(1 − ratio) · 10^(−x/10)` on the through port and `ratio · 10^(−x/10)` on the tap port. The four ring couplers pay it too.
- **Crossover curve.** The sweep from 2 to 60 cm (`solveFrontier`) solves the link at every length instead of anchoring on a fixed reference:
  - *Optical:* polymer length only scales the field (its phase cancels), so the noiseless power from one length is exact at every other length once rescaled by the loss difference. Noise is added again and Q is read from the eye.
  - *Copper:* each length gets a minimum-phase channel built from the skin-effect and dielectric loss, a Wiener (MMSE) equaliser, receiver noise and crosstalk. A channel over the generation's mask is cut into equal hops, each regenerated by a retimer. Hop bit errors add, and Q is quoted as the Q that gives the summed BER. That is why copper Q can rise again where a second hop starts.
  - The crossover is the first length where optics are usable (BER at or below the format's target, loss inside 20 dB) and either cost no more energy per bit or copper itself misses the BER target.
  - The BER target is the pre-FEC limit the spec allows: 1e-12 for NRZ and 1e-6 for PAM4, which relies on the generation's forward error correction. Copper and optics are held to the same target.
- **PAM4 record length.** PRBS-15 starts from register 1, so its first 128 PAM4 symbols contain no −1 level. PAM4 records are therefore at least 256 symbols (`PAM4_MIN_SYMBOLS`).
- **Thermal runaway.** Leakage doubles every 10 K above 75 °C. If leakage alone out-runs the cooler, the part is reported at its thermal trip with the clock gated off, flagged as runaway.

Assumptions that are stated rather than measured, so change them for your board:

- The modulator figures (`MODULATORS`: Vπ·L, loss per mm, excess loss, capacitance per mm, bandwidth·length, static extinction) are representative published-range values for each material, not a vendor's data. Rank the materials with them, but do not quote the absolute numbers.
- Copper receiver noise is 8 nV/√Hz (about 1 mV rms over a 16 GHz Nyquist band) and aggregate crosstalk is −26 dB, which caps an NRZ copper eye near Q ≈ 20 and a PAM4 eye near Q ≈ 8. They are `rxNoise` and `copperXtalk`. On the seven presets copper Q is already 18 to 25, so these two do not move any result there.
- Q comes from one seeded record, so it carries about ±20 % sampling jitter at 128 symbols. The closed-form parts (loss, resonance, energy) do not.
- PAM4 optics at 64 and 112 Gbit/s have a Q of 2 to 3 at 10 cm, far short of the 1e-6 pre-FEC target (Q about 4.75 for four levels), so they read down. Copper PAM4 meets the target at 64 Gbit/s (Q 7.5) and misses it at 112 Gbit/s (Q 4.4). The crossover for PAM4 is therefore "none".

The model's assumed constants are in one registry (`ASSUMPTIONS` in `src/lib/limen.ts`). The **Run sensitivity** button varies each by ±25 % on the board you have built. On the presets, DDR3 and DDR4 are robust, DDR2, DDR5 and Arrow are sensitive, and the 96c and Gen7 presets are fragile: their optical eye closes if the launch power or the receiver bandwidth is 25 % lower. Treat their optical numbers as a thin margin.

The sources for the datasheet values, and the list of assumed constants, are in [docs/sources.md](docs/sources.md).

## Where the code is

| Path | Role |
| --- | --- |
| `src/lib/limen.ts` | Copper x16, dies, optical cascade, eye, and frontier used by the page |
| `src/components/dashboard.tsx` | The motherboard and the four phase views |
| `src/lib/assess.ts` | Status classes from a solved board (stability, efficiency, overall, findings) |
| `src/lib/sensitivity.ts` | The ±25 % sweep over the assumed constants |
| `src/lib/report.ts` | Markdown, JSON and CSV export |
| `src/components/status-panel.tsx` | The Status, Sensitivity and Report blocks |
| `tests/` | `npm test`: model, status, sensitivity and report tests |
| `src/styles.css` | All of the page styling |
| `src/lib/format.ts` | Number formatting |
| `src/lib/error-component.tsx` | The fallback shown if the page throws |
| `src/routes/`, `src/router.tsx` | TanStack Start routing; `src/routeTree.gen.ts` is generated on first run |

The ring walk is \(\Delta\lambda = (\lambda / n_g)(dn/dT)\Delta T\), and the page does not call any server while you move a slider.

## License

LIMEN is released under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). You can use, study, change and share it. If you run a modified version for other people over a network, the AGPL requires you to offer them the source of your version.
