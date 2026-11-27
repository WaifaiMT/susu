import type { Role } from "@/db/schema";
import { AppError } from "./errors";

// One map for every permission check. Roles in a susu group:
//   collector  runs the group: sets the rules, the payout order, starts cycles
//   treasurer  helps run it: invites members, records cash, reads the ledger, can't change the rules
//   member     pays in, gets paid out, sees the group's progress
export const PERMISSIONS = {
  "cycles:read": ["collector", "treasurer", "member"],
  "cycles:manage": ["collector"],
  "contributions:record_cash": ["collector", "treasurer"],
  "ledger:read": ["collector", "treasurer"],
  "members:read": ["collector", "treasurer", "member"],
  "members:invite": ["collector", "treasurer"],
  "members:manage": ["collector", "treasurer"],
  "audit:read": ["collector", "treasurer"],
  "org:update": ["collector", "treasurer"],
  "org:delete": ["collector"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const ROLE_LABELS: Record<Role, string> = {
  collector: "Collector",
  treasurer: "Treasurer",
  member: "Member",
};

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new AppError("forbidden", "You don't have permission to do that.");
  }
}

/** Treasurers can manage members but can't create or modify collectors. */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (actor === "collector") return true;
  if (actor === "treasurer") return target !== "collector";
  return false;
}
