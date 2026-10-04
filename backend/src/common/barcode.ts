/**
 * Barcodes for labels and warehouse scanning (PRD FR-PRD-12, backend doc 8.23): GS1 check digits, the
 * rule for what may be stored as a barcode, internal numbers, and the bars of EAN-13, EAN-8, and Code 128
 * ready to draw. Pure functions; the symbol tables were checked against the published tables (Code 128
 * and EAN-13 articles, October 2026).
 */

const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/** GS1 mod-10 check digit of the digits before it: weight 3 on the rightmost, then 1, alternating. */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** All digits, as long as an EAN-8, UPC-A, EAN-13, or GTIN-14. */
export const isGtinShaped = (code: string): boolean => /^\d+$/.test(code) && GTIN_LENGTHS.has(code.length);

export function isValidGtin(code: string): boolean {
  return isGtinShaped(code) && gtinCheckDigit(code.slice(0, -1)) === code.charCodeAt(code.length - 1) - 48;
}

export const BARCODE_MAX = 48;

/**
 * Why a code cannot be stored as a variant's barcode, or null. Scanners type what the bars hold, so it is
 * printable ASCII without spaces; a number as long as an EAN or UPC must carry its check digit, since a
 * wrong last digit is nearly always a typing mistake.
 */
export function barcodeProblem(code: string): string | null {
  if (!new RegExp(`^[\\x21-\\x7E]{1,${BARCODE_MAX}}$`).test(code)) {
    return `Barcode berisi huruf, angka, dan tanda baca tanpa spasi, paling banyak ${BARCODE_MAX} karakter.`;
  }
  if (isGtinShaped(code) && !isValidGtin(code)) {
    return "Digit terakhir tidak cocok untuk barcode EAN/UPC. Periksa lagi angkanya.";
  }
  return null;
}

/**
 * Internal EAN-13 for a product without one: GS1 prefix 20 ("restricted circulation", for use inside one
 * company), a 10-digit number, and the check digit. Valid on every scanner, never sold under.
 */
export function internalEan13(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > 9_999_999_999)
    throw new RangeError(`internal barcode out of range: ${n}`);
  const body = `20${String(n).padStart(10, "0")}`;
  return `${body}${gtinCheckDigit(body)}`;
}

// ---- bars ----

export interface Bar {
  /** Offset from the left edge of the symbol, in modules. */
  x: number;
  /** Width in modules. */
  w: number;
  /** EAN guard bars, drawn a little longer. */
  guard: boolean;
}

export interface Barcode {
  symbology: "ean13" | "ean8" | "code128";
  /** Width of the symbol in modules, without quiet zones. */
  modules: number;
  /** Clear space each side needs, in modules. */
  quiet: { left: number; right: number };
  bars: Bar[];
  /** What is printed under the bars. */
  text: string;
}

const EAN_L = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011",
];
const EAN_G = [
  "0100111",
  "0110011",
  "0011011",
  "0100001",
  "0011101",
  "0111001",
  "0000101",
  "0010001",
  "0001001",
  "0010111",
];
const EAN_R = [
  "1110010",
  "1100110",
  "1101100",
  "1000010",
  "1011100",
  "1001110",
  "1010000",
  "1000100",
  "1001000",
  "1110100",
];
/** Parity of the six left digits of an EAN-13, chosen by its first digit. */
const EAN13_PARITY = [
  "LLLLLL",
  "LLGLGG",
  "LLGGLG",
  "LLGGGL",
  "LGLLGG",
  "LGGLLG",
  "LGGGLL",
  "LGLGLG",
  "LGLGGL",
  "LGGLGL",
];

function barsOf(modules: string, guards: [number, number][]): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < modules.length; ) {
    if (modules[i] !== "1") {
      i++;
      continue;
    }
    let w = 1;
    while (modules[i + w] === "1") w++;
    bars.push({ x: i, w, guard: guards.some(([from, to]) => i >= from && i < to) });
    i += w;
  }
  return bars;
}

const digit = (s: string, i: number) => s.charCodeAt(i) - 48;

export function ean13(code: string): Barcode {
  if (!/^\d{13}$/.test(code) || !isValidGtin(code)) throw new RangeError(`not an EAN-13: ${code}`);
  const parity = EAN13_PARITY[digit(code, 0)]!;
  let modules = "101";
  for (let i = 1; i <= 6; i++) modules += (parity[i - 1] === "L" ? EAN_L : EAN_G)[digit(code, i)];
  modules += "01010";
  for (let i = 7; i <= 12; i++) modules += EAN_R[digit(code, i)];
  modules += "101";
  return {
    symbology: "ean13",
    modules: modules.length,
    quiet: { left: 11, right: 7 },
    bars: barsOf(modules, [
      [0, 3],
      [45, 50],
      [92, 95],
    ]),
    text: `${code[0]} ${code.slice(1, 7)} ${code.slice(7)}`,
  };
}

export function ean8(code: string): Barcode {
  if (!/^\d{8}$/.test(code) || !isValidGtin(code)) throw new RangeError(`not an EAN-8: ${code}`);
  let modules = "101";
  for (let i = 0; i < 4; i++) modules += EAN_L[digit(code, i)];
  modules += "01010";
  for (let i = 4; i < 8; i++) modules += EAN_R[digit(code, i)];
  modules += "101";
  return {
    symbology: "ean8",
    modules: modules.length,
    quiet: { left: 7, right: 7 },
    bars: barsOf(modules, [
      [0, 3],
      [31, 36],
      [64, 67],
    ]),
    text: `${code.slice(0, 4)} ${code.slice(4)}`,
  };
}

/** Code 128 symbol widths (bar, space, bar, space, bar, space) for values 0 to 105, then the stop. */
const CODE128 = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112",
];
export const CODE128_PATTERNS: readonly string[] = CODE128;

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const STOP = 106;

/** Code 128 can hold this text: printable ASCII and space (code set B), digits packed in pairs (set C). */
export const code128Encodable = (text: string): boolean => /^[\x20-\x7E]{1,80}$/.test(text);

/**
 * Symbol values of a Code 128 barcode: start, data, check, stop. Digit runs worth it (4 or more at the
 * start or end, 6 or more inside) go in pairs through code set C, the rest through code set B.
 */
export function code128Values(text: string): number[] {
  if (!code128Encodable(text)) throw new RangeError("Code 128 holds printable ASCII only");
  const isDigit = (i: number) => i < text.length && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57;
  const run = (from: number) => {
    let n = 0;
    while (isDigit(from + n)) n++;
    return n;
  };
  const values: number[] = [];
  const first = run(0);
  let set: "B" | "C" = first >= 4 || (first === text.length && first % 2 === 0) ? "C" : "B";
  values.push(set === "C" ? START_C : START_B);
  let i = 0;
  while (i < text.length) {
    const n = run(i);
    if (set === "C") {
      if (n >= 2) {
        values.push(Number(text.slice(i, i + 2)));
        i += 2;
      } else {
        values.push(CODE_B);
        set = "B";
      }
      continue;
    }
    if ((n >= 4 && i + n === text.length) || n >= 6) {
      // an odd run leaves its first digit in set B
      if (n % 2 === 1) {
        values.push(text.charCodeAt(i) - 32);
        i++;
      }
      values.push(CODE_C);
      set = "C";
      continue;
    }
    values.push(text.charCodeAt(i) - 32);
    i++;
  }
  let sum = values[0]!;
  for (let k = 1; k < values.length; k++) sum += values[k]! * k;
  values.push(sum % 103, STOP);
  return values;
}

export function code128(text: string): Barcode {
  const bars: Bar[] = [];
  let x = 0;
  for (const value of code128Values(text)) {
    const widths = CODE128[value]!;
    for (let k = 0; k < widths.length; k++) {
      const w = widths.charCodeAt(k) - 48;
      if (k % 2 === 0) bars.push({ x, w, guard: false });
      x += w;
    }
  }
  return { symbology: "code128", modules: x, quiet: { left: 10, right: 10 }, bars, text };
}

/**
 * The symbol for a label: EAN-13 for EAN-13 and UPC-A numbers (UPC-A is EAN-13 with a leading zero),
 * EAN-8 for EAN-8, Code 128 for everything else, including GTIN-14.
 */
export function barcodeFor(value: string): Barcode {
  if (isValidGtin(value)) {
    if (value.length === 13) return ean13(value);
    if (value.length === 12) return { ...ean13(`0${value}`), text: value };
    if (value.length === 8) return ean8(value);
  }
  return code128(value);
}
