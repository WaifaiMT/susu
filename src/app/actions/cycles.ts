"use server";

import { refresh } from "next/cache";
import { runAction, type ActionState } from "@/lib/actions";
import { requireOrg } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { getFakeProvider } from "@/lib/payments";
import { checkContribution, getContributionReference, recordCashContribution, startContribution, submitContributionOtp, type SettleOutcome } from "@/lib/services/contributions";
import { createDraftCycle, discardDraft, moveMember, shuffleOrder, startCycle } from "@/lib/services/cycles";
import {
  checkPayout,
  closeCycle,
  getPendingPayoutReference,
  recordCashDeposit,
  setPayoutAccount,
  startRefund,
  startRoundPayout,
  type PayoutOutcome,
} from "@/lib/services/payouts";
import { reconcile } from "@/lib/services/reconciliation";
import { processWebhook } from "@/lib/services/webhooks";

// Every action re-reads the session and membership on the server; the slug
// is bound by the page, and the services check the role.

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function createDraftCycleAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await createDraftCycle(await requireOrg(slug), {
      amount: field(form, "amount"),
      frequency: field(form, "frequency"),
      startsOn: field(form, "startsOn"),
      orderMethod: field(form, "orderMethod"),
    });
    refresh();
  });
}

export async function moveMemberAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const direction = field(form, "direction") === "up" ? "up" : "down";
    await moveMember(await requireOrg(slug), field(form, "cycleId"), field(form, "userId"), direction);
    refresh();
  });
}

export async function shuffleOrderAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await shuffleOrder(await requireOrg(slug), field(form, "cycleId"));
    refresh();
  });
}

export async function startCycleAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await startCycle(await requireOrg(slug), field(form, "cycleId"));
    refresh();
  });
}

export async function discardDraftAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await discardDraft(await requireOrg(slug), field(form, "cycleId"));
    refresh();
  });
}

// ---- Contributions -----------------------------------------------------------

export async function startContributionAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const result = await startContribution(await requireOrg(slug), {
      roundId: field(form, "roundId"),
      phone: field(form, "phone"),
      network: field(form, "network") || undefined,
    });
    refresh();
    if (result.status === "failed") throw new AppError("validation", result.message ?? "The payment was declined.");
    return result.message;
  });
}

export async function submitOtpAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const result = await submitContributionOtp(await requireOrg(slug), field(form, "contributionId"), field(form, "otp"));
    refresh();
    return result.message;
  });
}

export async function checkContributionAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const outcome = await checkContribution(await requireOrg(slug), field(form, "contributionId"));
    refresh();
    return CHECK_MESSAGES[outcome];
  });
}

const CHECK_MESSAGES: Record<SettleOutcome, string> = {
  succeeded: "Paid. Thank you!",
  duplicate: "This payment went through, but you'd already paid this round. The treasurer will refund it.",
  mismatch: "A payment arrived, but not for the right amount. The treasurer will refund it.",
  failed: "The payment didn't go through.",
  still_pending: "Still waiting for you to approve the prompt on your phone.",
  already_settled: "This payment is already up to date.",
  reported_failed_after_payment: "The provider reported a problem with this payment. The treasurer has been notified.",
  unknown_reference: "The payment provider doesn't know this payment yet. Try again in a minute.",
};

export async function recordCashAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await recordCashContribution(await requireOrg(slug), { roundId: field(form, "roundId"), userId: field(form, "userId") });
    refresh();
  });
}

/** Development only: plays the member's phone and the provider's callback for the built-in test provider. */
export async function simulatePaymentAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const fake = getFakeProvider();
    if (!fake) throw new AppError("forbidden", "Simulated payments only work with the test provider.");
    const ctx = await requireOrg(slug);
    const contributionId = field(form, "contributionId");
    const { reference, amountPesewas } = await getContributionReference(ctx, contributionId);
    fake.settle(reference, field(form, "outcome") === "approve" ? "success" : "failed", undefined, amountPesewas);
    // Deliver the provider's webhook through the same path a real one takes
    await processWebhook("fake", fake.webhookFor(reference));
    refresh();
  });
}

// ---- Payouts, refunds, cash, closing, reconciliation -------------------------

export async function setPayoutAccountAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await setPayoutAccount(await requireOrg(slug), { phone: field(form, "phone"), network: field(form, "network") || undefined });
    refresh();
    return "Saved. Your payout will go to this number.";
  });
}

const PAYOUT_MESSAGES: Record<PayoutOutcome, string> = {
  succeeded: "Paid out.",
  failed: "The payout didn't go through. You can try again.",
  reversed: "The payout came back from the wallet. The pot is owed again.",
  still_pending: "Still on its way. The provider hasn't finished it yet.",
  already_settled: "This payout is already up to date.",
  needs_attention: "Our record and the provider's disagree. It's in the audit log: check before doing anything else.",
  unknown_reference: "The provider doesn't know this payout.",
};

export async function startPayoutAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const method = field(form, "method") === "cash" ? "cash" : "momo";
    const result = await startRoundPayout(await requireOrg(slug), field(form, "roundId"), method);
    refresh();
    if (result.status === "succeeded") return method === "cash" ? "Recorded as paid out in cash." : "Paid out.";
    if (result.status === "failed") throw new AppError("validation", "The provider refused the payout. Check the number, then try again.");
    return "message" in result && result.message ? result.message : "Sent. Waiting for the provider to confirm.";
  });
}

export async function startRefundAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const result = await startRefund(await requireOrg(slug), field(form, "contributionId"));
    refresh();
    return result.status === "succeeded" ? "Refunded." : "Refund sent. Waiting for the provider to confirm.";
  });
}

export async function checkPayoutAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const outcome = await checkPayout(await requireOrg(slug), field(form, "payoutId"));
    refresh();
    return PAYOUT_MESSAGES[outcome];
  });
}

/** Development only: plays the provider finishing (or failing) a payout, and its webhook. */
export async function simulatePayoutAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const fake = getFakeProvider();
    if (!fake) throw new AppError("forbidden", "Simulated payouts only work with the test provider.");
    const ctx = await requireOrg(slug);
    const { reference, amountPesewas } = await getPendingPayoutReference(ctx, field(form, "payoutId"));
    fake.settlePayout(reference, field(form, "outcome") === "success" ? "success" : "failed", amountPesewas);
    await processWebhook("fake", fake.webhookFor(reference, "payout"));
    refresh();
  });
}

export async function recordCashDepositAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await recordCashDeposit(await requireOrg(slug), { amount: field(form, "amount"), note: field(form, "note") });
    refresh();
    return "Recorded.";
  });
}

export async function closeCycleAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await closeCycle(await requireOrg(slug), field(form, "cycleId"));
    refresh();
  });
}

export async function reconcileAction(slug: string): Promise<ActionState> {
  return runAction(async () => {
    const summary = await reconcile(await requireOrg(slug));
    refresh();
    return `${summary.checked} checked: ${summary.matched} matched, ${summary.fixed} fixed, ${summary.problems} ${summary.problems === 1 ? "problem" : "problems"}.`;
  });
}
