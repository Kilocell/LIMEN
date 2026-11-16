# Sources and assumptions

This file says where each number in LIMEN comes from, and which numbers are assumptions. It was written after a datasheet pass in November 2026. Vendor pages change, so recheck a value before you rely on it.

Three labels are used:

- **Datasheet**: matches a vendor page or a standards-body document that was read.
- **Reported**: matches a secondary source (trade press or a vendor white paper) quoting the standard.
- **Assumed**: a representative value chosen for the model. Not measured, not from a foundry.

## PCIe channel insertion-loss masks

The copper channel must stay inside the generation's whole-channel mask at the Nyquist frequency. Past it, the model adds retimers.

| Generation | Mask (dB) | Label | Source |
| --- | --- | --- | --- |
| 1.0 | 13 | Reported | PCI-SIG APAC Developers Conference deck from 2004 (slide 4: "Interconnect Loss < 13.2 dB"; no frequency stated), and a 2006 Samtec/Teraspeed note that derives it at 1.25 GHz as 20·log10(175 mV / 800 mV) = 13.2 dB. The base spec is members-only and was not read |
| 2.0 | 17 | Assumed | Not confirmed. One secondary source (Altium) gives 12 dB, so the two disagree. Only a Gen 2 board you choose yourself uses it, because no preset trains at Gen 2 |
| 3.0 | 22 | Reported | Astera Labs table of PCIe loss budgets |
| 4.0 | 28 | Reported | Astera Labs table of PCIe loss budgets |
| 5.0 | 36 | Reported | Astera Labs and Promwad, 36 dB bump to bump |
| 6.0 | 32 | Reported | Tektronix PCIe 6 validation white paper, 32 dB at 16 GHz |
| 7.0 | 36 | Reported | Four secondary sources say 36 dB pad to pad (three give 32 GHz; Synopsys gives no frequency). Two predate the June 2025 release (Synopsys, Signal Integrity Journal 2024) and two are after it (Keysight in Signal Integrity Journal, October 2026; Electronic Design, August 2026). The base spec is members-only and was not read |

## Presets

Each preset is one real machine. The model draws a typical full load, not the power limit, so modelled board power sits below the rated figure.

| Preset | Part | In the model | Datasheet | Note |
| --- | --- | --- | --- | --- |
| DDR2 · 2007 | Athlon 64 X2 5200+ (Brisbane, 65 nm) | 2 cores, 2.7 GHz | 2.7 GHz, 65 W | 65 nm Brisbane. The 90 nm Windsor 5200+ ran 2.6 GHz |
| | GeForce 8800 GTS 512 | 128 shaders, GDDR3 | 128 stream processors, 256-bit GDDR3 | A PCIe 2.0 card in a PCIe 1.x slot. No source found states the nForce 520's slot generation: Wikipedia's chipset comparison gives "1.0a" for the generic nForce 500, 570 SLI and 590 SLI rows but leaves the 520 row blank (an older copy of that page lists the 520 LE as "1.1"). Gen 1 is inferred from the family. 1.0a and 1.1 both run at 2.5 GT/s, so the model is the same either way |
| DDR3 · 2012 | Core i7-3770K | 4 cores, 8 threads, 3.5 GHz | 4 cores, 8 threads, 3.5 GHz base, 3.9 GHz turbo, 77 W, DDR3-1600, PCIe 3.0 | Intel ARK |
| | GeForce GTX 680 | 1536 shaders, 1.058 GHz | 1536 CUDA cores, 195 W | Modelled 171 W |
| DDR4 · 2022 | Raptor Cove on B660 | 8 cores, 16 threads, 4.8 GHz | The i7-13700K has 16 cores and 24 threads | The model has no hybrid cores, so this is the P-cores only |
| | GeForce RTX 3070 Ti | 6144 shaders, GDDR6X | 6144 CUDA cores, 290 W | Modelled 248 W |
| DDR5 · 2025 | Ryzen 9 9950X on X670E | 16 cores, 32 threads, 5.0 GHz, DDR5-6000 | 16 cores, 170 W TDP, DDR5-5600 official | 6000 is a common EXPO kit |
| | GeForce RTX 5090 | 21760 shaders, 32 GB GDDR7 | 575 W | Modelled 581 W |
| Arrow · 2025 | Core Ultra 9 285K on Z890 | 24 cores, 24 threads, 5.0 GHz | 24 cores, 24 threads, no Hyper-Threading, 5.5 GHz P-core turbo, 250 W turbo | Labelled 2025 because the RTX 5080 launched in January 2025 |
| | GeForce RTX 5080 | 10752 shaders, 16 GB GDDR7 | 360 W | Modelled 330 W |
| 96c · 2023 | Threadripper PRO 7995WX on WRX90 | 96 cores, 192 threads, 2.5 GHz, DDR5-5200 | 96 cores, 192 threads, 2.5 GHz base, 5.1 GHz boost, 350 W, 8-channel DDR5-5200, PCIe 5.0 | AMD product page. Modelled 384 W |
| | H100 PCIe | 14592 shaders, 456 tensor cores, 80 GB HBM2e | 14592 CUDA cores, 456 tensor cores, 350 W, 48 TFLOPS FP32 and about 2000 GB/s in NVIDIA's Hopper article | The model gives 51.2 TFLOPS from cores × 2 × 1.755 GHz and 2048 GB/s from 5 stacks at 3.2 Gbit/s |
| Gen7 · 2027+ | Projected | Megtron-class board, 1 retimer | None | Not a real product |

## Constants that are assumed

These are in the `ASSUMPTIONS` registry in `src/lib/limen.ts`, and the model reads each one through `assumed()`. The dashboard's **Run sensitivity** button and the report's sensitivity section run the model with each constant at 0.75 and 1.25 of its value (`SENSITIVITY_SPREAD`) and say which results move. A new assumed constant must be added to the registry and to this table.

| Key | Value | What it does |
| --- | --- | --- |
| `phyFixedShare` | 0.25 | Share of the SerDes energy that does not scale with channel loss |
| `opticalFixtureShare` | 2/3 | Share of the board fixture loss seen by the short die-to-engine hop |
| `rxBwFrac` | 0.7 | Receiver 3 dB bandwidth as a fraction of the symbol rate |
| `launchW` | 1 mW | Optical power leaving the modulator at its on level |
| `laserMaxW` | 20 mW | Laser output limit per lane |
| `tiaJ` | 0.8 pJ/bit | Receiver amplifier energy |
| `laserWpe` | 10 % | Electrical-to-optical efficiency of the laser |
| `fixtureLoss` | 1.25 dB at 1 GHz, scaled by `(f / 1 GHz)^0.9` | Package, via and connector loss on top of the trace |
| `rxNoise` | 8 nV/√Hz | Copper receiver noise floor |
| `copperXtalk` | −26 dB | Aggregate copper crosstalk |
| Modulator materials (`MODULATORS`) | See the table in the code | Silicon, thin-film lithium niobate and electro-optic polymer values are representative, not foundry data. They are not in the sensitivity sweep |

What the sweep showed on the seven presets (November 2026):

- The crossover lengths are driven by energy, not by signal quality: copper Q is 16 to 25 on every preset, far above its target, so the copper noise floor (`rxNoise`), the crosstalk (`copperXtalk`) and the laser limit (`laserMaxW`) change nothing there. They only matter on a board with a much lossier channel, and a test checks that they do move copper when pushed hard.
- The verdicts are: robust (numbers may shift, but no conclusion flips), sensitive (some ±25 % change flips a conclusion, such as which medium is cheaper or whether a crossover exists) and fragile (some change takes a working link down). DDR3 and DDR4 are robust. DDR2, DDR5 and Arrow are sensitive.
- The 96c ("storm") and Gen7 presets are fragile: their optical eye closes when the launch power or the receiver bandwidth falls by 25 %. Read their optical results as a thin margin, not as a settled number.

## Where the datasheet values were read

- [PCIe 6.0 validation white paper, Tektronix](https://www.tek.com.cn/documents/whitepaper/pcie-6-phy-validation)
- [PCIe Gen 5 embedded design, Promwad](https://promwad.com/news/pcie-gen5-embedded-compute-nvme-storage-gpu-ai-accelerators)
- [PCIe 5.0 channel insertion loss budget, Astera Labs](https://www.asteralabs.com/?p=18375)
- [Evolution of PCIe beyond Gen7, Signal Integrity Journal](https://www.signalintegrityjournal.com/articles/4156-evolution-of-pcie-beyond-gen7-pcie-gen8)
- [Ryzen Threadripper PRO 7995WX, AMD](https://www.amd.com/en/support/downloads/drivers.html/processors/ryzen-threadripper-pro/amd-ryzen-threadripper-pro-7000-wx-series/amd-ryzen-threadripper-pro-7995wx.html)
- [Core i7-13700K, Intel](https://www.intel.com/content/www/us/en/products/sku/230500/intel-core-i713700k-processor-30m-cache-up-to-5-40-ghz/specifications.html)
- [Core i7-3770K, Intel](https://www.intel.com/content/www/us/en/products/sku/65523/intel-core-i73770k-processor-8m-cache-up-to-3-90-ghz/specifications.html)
- [B660 chipset, Intel](https://www.intel.com/content/www/us/en/products/sku/218832/intel-b660-chipset/specifications.html)
- [AM5 chipsets, AMD](https://www.amd.com/en/products/processors/chipsets/am5.html)
- [Athlon 64 X2 5200+, TechPowerUp CPU database](https://techpowerup.com/cpudb/479/athlon-64-x2-5200)
- [GA-M52S-S3P (nForce 520), Gigabyte](https://www.gigabyte.com/Motherboard/GA-M52S-S3P-rev-20/sp)
- [NVIDIA Hopper Architecture In-Depth](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/)
- [H100 PCIe product brief, NVIDIA](https://www.nvidia.com/content/dam/en-zz/Solutions/gtcs22/data-center/h100/PB-11133-001_v01.pdf)
- [BFG GeForce 8800 GTS 512 MB launch, TechPowerUp](https://www.techpowerup.com/46737/bfg-launches-512mb-8800-gts)
- [Board Design Guidelines for PCI Express Architecture, PCI-SIG APAC Developers Conference 2004 (copy hosted by NXP)](https://community.nxp.com/pwmxy87654/attachments/pwmxy87654/powerquicc/2284/3/PCIe_layout_1.pdf) (Gen 1, 13.2 dB. PCI-SIG's own copy was not found)
- [PCI Express Gen 1 application note, Samtec/Teraspeed, March 2006](https://suddendocs.samtec.com/notesandwhitepapers/app-note_pcie_pci-express-gen1_web.pdf) (Gen 1, 13.2 dB at 1.25 GHz from 175 mV / 800 mV)
- [Comparison of Nvidia nForce chipsets, Wikipedia](https://en.wikipedia.org/wiki/Comparison_of_Nvidia_nForce_chipsets) (PCIe 1.0a for nForce 500, 570 SLI and 590 SLI. The 520 row is blank)
- [PCIe 7.0 at 128 GT/s: PAM4 Validation in Real CEM Channels, Keysight, Signal Integrity Journal](https://www.signalintegrityjournal.com/articles/4349-pcie-70-at-128-gt-s-pam4-validation-in-real-cem-channels) (October 2026, after the release: pad-to-pad about −36 dB at 32 GHz. Its Table 2 is an image and was not read)
- [The Bandwidth Arms Race: Inside the Leap from PCIe Gen 6 to Gen 8, Electronic Design](https://www.electronicdesign.com/technologies/industrial/article/55399189/logic-fruit-technologies-the-bandwidth-arms-race-inside-the-leap-from-pcie-gen-6-to-gen-8) (Gen 7 −36 dB at 32 GHz, from a search excerpt)
- [PCIe in PCB Design: Layout and Routing Guidelines, Altium](https://resources.altium.com/p/pcie-layout-and-routing-guidelines) (12 dB for Gen 2, a generic layout budget)
- [How PCIe 7.0 Addresses AI's Bandwidth Demands, Synopsys](https://www.synopsys.com/designware-ip/technical-bulletin/pcie-7-design-ai-bandwidth.html) (July 2024, pad-to-pad loss up to 36 dB, written when the spec was at version 0.5)
- [Navigating signal integrity challenges, PCIe Gen6 to Gen7, Signal Integrity Journal](https://www.signalintegrityjournal.com/articles/3462-navigating-signal-integrity-challenges-transitioning-from-pcie-gen6-to-gen7) (36 dB at 32 GHz)

The PCI-SIG page that announces the PCIe 7.0 release could not be opened from the tool used, and the specification itself is for members only, so no mask here was read from a PCI-SIG specification. The 13.2 dB deck is dated 2004, not 2005.

The RTX 5090, RTX 5080, RTX 3070 Ti, GTX 680, Ryzen 9 9950X and Core Ultra 9 285K figures come from the vendors' product pages and the TechPowerUp GPU database, read in the same pass. Their exact page links were not kept, so recheck them against the vendor page before you cite them.
