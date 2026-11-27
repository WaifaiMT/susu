import { createHash, randomBytes } from "node:crypto";

/** A random URL-safe token (256 bits). Give the raw token to the user; store only its hash. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
