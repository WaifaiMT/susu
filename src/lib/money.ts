import { AppError } from "./errors";

// Money is an integer number of pesewas everywhere (GHS 1 = 100 pesewas).
// Floats never touch it: 0.1 + 0.2 !== 0.3, and a ledger can't be "nearly" right.

const CEDIS = /^(\d{1,7})(?:\.(\d{1,2}))?$/;

/** Parses what a person types ("100", "50.5", "1,200.00") into pesewas, using string maths only. */
export function parseCedis(input: string): number {
  const clean = input.trim().replace(/,/g, "").replace(/^(GHS|GH₵|₵)\s*/i, "");
  const match = CEDIS.exec(clean);
  if (!match) throw new AppError("validation", "Enter an amount in cedis, like 100 or 50.50.");
  const [, whole, fraction = ""] = match;
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** 105050 → "GH₵ 1,050.50" */
export function formatCedis(pesewas: number): string {
  if (!Number.isSafeInteger(pesewas)) throw new Error(`Not a whole number of pesewas: ${pesewas}`);
  const sign = pesewas < 0 ? "−" : "";
  const abs = Math.abs(pesewas);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const fraction = String(abs % 100).padStart(2, "0");
  return `${sign}GH₵ ${whole}.${fraction}`;
}
