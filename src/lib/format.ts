const SUPER_DIGIT = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];

/**
 * Scientific notation with superscript exponent: mantissa × 10^exp.
 * Die extents are 10⁷ nm and areas are 10¹⁴ nm².
 *
 * The mantissa is rounded to 2 decimals *before* the exponent is chosen, so a
 * value such as 9.999e6 prints as "1.00×10⁷" and never as "10.00×10⁶".
 */
export function sci(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  let exp = Math.floor(Math.log10(Math.abs(value)));
  let mant = Number((value / 10 ** exp).toFixed(2));
  if (Math.abs(mant) >= 10) {
    exp += 1;
    mant = Number((value / 10 ** exp).toFixed(2));
  }
  const body = String(Math.abs(exp))
    .split("")
    .map((digit) => SUPER_DIGIT[Number(digit)] ?? "")
    .join("");
  return `${mant.toFixed(2)}×10${exp < 0 ? "⁻" : ""}${body}`;
}
