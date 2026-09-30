/**
 * Money is whole rupiah. Stored as bigint in PostgreSQL, handled as a safe integer `number` in the app.
 * Anything that is not a whole number within the safe range is rejected, never rounded.
 */
export type Rupiah = number & { readonly __brand: "Rupiah" };

export class InvalidMoneyError extends Error {
  constructor(value: unknown) {
    super(`invalid rupiah amount: ${String(value)}`);
    this.name = "InvalidMoneyError";
  }
}

export function rupiah(value: number | bigint | string): Rupiah {
  let n: number;
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new InvalidMoneyError(value);
    }
    n = Number(value);
  } else if (typeof value === "string") {
    if (!/^-?\d+$/.test(value)) throw new InvalidMoneyError(value);
    n = Number(value);
  } else {
    n = value;
  }
  if (!Number.isSafeInteger(n)) throw new InvalidMoneyError(value);
  return n as Rupiah;
}

export function addRupiah(...amounts: Rupiah[]): Rupiah {
  return rupiah(amounts.reduce<number>((sum, a) => sum + a, 0));
}

/** Percentage of an amount, rounded half away from zero to whole rupiah. `pct` is e.g. 4.5 for 4.5%. */
export function percentOf(amount: Rupiah, pct: number): Rupiah {
  const raw = (amount * pct) / 100;
  return rupiah(Math.sign(raw) * Math.round(Math.abs(raw)));
}

const idFormatter = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });

/** UI format from DOKUMEN-UI-UX section 5: "Rp 1.250.000", "-Rp 14.000". */
export function formatRupiah(amount: Rupiah | number): string {
  const n = rupiah(amount);
  const body = `Rp ${idFormatter.format(Math.abs(n))}`;
  return n < 0 ? `-${body}` : body;
}
