import { z } from "zod";
import { AppError } from "./errors";

/** Validates an id from a form or URL, so a tampered value is a clean "not found" instead of a database error. */
export function parseId(value: unknown): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new AppError("not_found", "That item doesn't exist.");
  return parsed.data;
}
