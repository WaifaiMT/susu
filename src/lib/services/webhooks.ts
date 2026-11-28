import { eq } from "drizzle-orm";
import { PesewaError, isPayoutProvider, type Payment, type Payout, type WebhookRequest } from "pesewa";
import { getDb } from "@/db/client";
import { webhookEvents } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { getProvider } from "../payments";
import { findOrganization, settleIn } from "./contributions";
import { settlePayoutIn } from "./payouts";

/**
 * Handles a provider's webhook: authenticate and confirm it (pesewa), record
 * the event once, and settle it, all in one transaction. If settling fails,
 * the event isn't recorded either, so the provider's retry gets another go.
 *
 * Providers send collection and payout events to the same URL, so the event
 * goes to both pesewa handlers; each returns null for the other kind.
 */
export async function processWebhook(
  providerName: string,
  request: WebhookRequest,
): Promise<{ status: 200 | 401 | 404; outcome: string }> {
  let provider;
  try {
    provider = getProvider(providerName);
  } catch {
    return { status: 404, outcome: "unknown_provider" };
  }

  let event: { kind: "payment"; data: Payment } | { kind: "payout"; data: Payout } | null = null;
  try {
    const payment = await provider.handleWebhook(request);
    if (payment) event = { kind: "payment", data: payment };
    else if (isPayoutProvider(provider)) {
      const payout = await provider.handlePayoutWebhook(request);
      if (payout) event = { kind: "payout", data: payout };
    }
  } catch (error) {
    if (error instanceof PesewaError && (error.code === "invalid_webhook" || error.code === "invalid_request")) {
      return { status: 401, outcome: "rejected" };
    }
    if (error instanceof PesewaError && error.code === "not_found") return { status: 200, outcome: "unknown_reference" };
    throw error; // provider unreachable: a 500 makes the provider retry later
  }
  if (!event) return { status: 200, outcome: "ignored" };

  const { reference, status } = event.data;
  const eventKey = `${event.kind}:${reference}:${status}`;
  const org = await findOrganization(provider.name, reference);
  if (!org) {
    await getDb().insert(webhookEvents).values({ provider: provider.name, eventKey, reference, outcome: "unknown_reference" }).onConflictDoNothing();
    return { status: 200, outcome: "unknown_reference" };
  }

  const outcome = await withTenant(org.schemaName, async (db) => {
    const [recorded] = await db
      .insert(webhookEvents)
      .values({ provider: provider.name, eventKey, reference, outcome: "processing" })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (!recorded) return "duplicate_event";
    const result =
      event.kind === "payment" ? await settleIn(db, org.id, provider.name, event.data) : await settlePayoutIn(db, org.id, provider.name, event.data);
    await db.update(webhookEvents).set({ outcome: result }).where(eq(webhookEvents.id, recorded.id));
    return result;
  });
  return { status: 200, outcome };
}
