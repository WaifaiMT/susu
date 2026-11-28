import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PesewaError,
  assertMinorUnits,
  normalizeGhanaPhone,
  type CollectRequest,
  type CollectResult,
  type MobileMoneyProvider,
  type Payment,
  type Payout,
  type PayoutProvider,
  type PayoutRequest,
  type PayoutResult,
  type WebhookRequest,
} from "pesewa";

// A stand-in payment provider for development, demos and tests, so the
// whole payment flow runs with no keys, no account, and no money. It behaves
// like a real one where it matters: collect() only starts a payment, the
// outcome arrives later as a signed webhook, and handleWebhook() checks the
// signature and then asks verify() for the truth.
//
// Test numbers (any network prefix):
//   ...0000  declined straight away (payments and payouts)
//   ...1111  asks for an OTP; the OTP is 123456
//   anything else: a prompt is "sent"; approve or decline it from the page
//
// State lives in this process's memory, so it's lost on restart. Dev only.

export const FAKE_OTP = "123456";
export const FAKE_SIGNATURE_HEADER = "x-fake-signature";

type FakePayment = { amount: number; status: "pending" | "otp_required" | "success" | "failed"; paidAmount?: number };
type FakePayout = { amount: number; status: "pending" | "success" | "failed" | "reversed" };

const globalForFake = globalThis as unknown as { fakePayments?: Map<string, FakePayment> };
const payments = (globalForFake.fakePayments ??= new Map());
const globalForFakePayouts = globalThis as unknown as { fakePayouts?: Map<string, FakePayout> };
const payoutsSent = (globalForFakePayouts.fakePayouts ??= new Map());

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export class FakeProvider implements MobileMoneyProvider, PayoutProvider {
  readonly name = "fake";

  constructor(private readonly secret: string) {}

  async collect(req: CollectRequest): Promise<CollectResult> {
    assertMinorUnits(req.amount);
    const phone = normalizeGhanaPhone(req.phone).local;
    if (payments.has(req.reference)) throw new PesewaError("duplicate_reference", "Fake: duplicate reference", { provider: this.name });

    if (phone.endsWith("0000")) {
      payments.set(req.reference, { amount: req.amount, status: "failed" });
      return { provider: this.name, status: "failed", reference: req.reference, message: "Declined (test number ending 0000)", raw: null };
    }
    const status = phone.endsWith("1111") ? "otp_required" : "pending";
    payments.set(req.reference, { amount: req.amount, status });
    return {
      provider: this.name,
      status,
      reference: req.reference,
      message: status === "otp_required" ? `Enter the OTP sent to ${phone} (it's ${FAKE_OTP})` : `Approve the prompt on ${phone}`,
      raw: null,
    };
  }

  async submitOtp(req: CollectRequest, otp: string): Promise<CollectResult> {
    const payment = payments.get(req.reference);
    if (!payment || payment.status !== "otp_required") throw new PesewaError("invalid_request", "Fake: no OTP pending for this payment");
    if (otp.trim() !== FAKE_OTP) throw new PesewaError("invalid_request", "That OTP is wrong. Check the code and try again.");
    // Like Paystack: after the OTP the member still approves the prompt
    payment.status = "pending";
    return { provider: this.name, status: "pending", reference: req.reference, message: "Approve the prompt on your phone", raw: null };
  }

  async verify(reference: string): Promise<Payment> {
    const payment = payments.get(reference);
    if (!payment) throw new PesewaError("not_found", "Fake: unknown reference", { provider: this.name });
    return {
      provider: this.name,
      reference,
      status: payment.status === "otp_required" ? "pending" : payment.status,
      amount: payment.status === "success" ? (payment.paidAmount ?? payment.amount) : undefined,
      currency: "GHS",
      failureReason: payment.status === "failed" ? "Declined by the member" : undefined,
      raw: null,
    };
  }

  async handleWebhook(req: WebhookRequest): Promise<Payment | null> {
    const event = this.event(req);
    // Never trust the body: confirm with verify(), like the real providers
    return event.kind === "payout" ? null : this.verify(event.reference);
  }

  private event(req: WebhookRequest): { reference: string; kind: string } {
    const headers = req.headers instanceof Headers ? Object.fromEntries(req.headers) : req.headers;
    const given = String(headers[FAKE_SIGNATURE_HEADER] ?? "");
    const expected = sign(this.secret, req.body);
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      throw new PesewaError("invalid_webhook", "Fake: bad signature", { provider: this.name });
    }
    let body: { reference?: unknown; kind?: unknown };
    try {
      body = JSON.parse(req.body);
    } catch {
      throw new PesewaError("invalid_webhook", "Fake: body isn't JSON", { provider: this.name });
    }
    if (typeof body.reference !== "string") throw new PesewaError("invalid_webhook", "Fake: no reference", { provider: this.name });
    return { reference: body.reference, kind: body.kind === "payout" ? "payout" : "payment" };
  }

  // ---- Payouts --------------------------------------------------------------------

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    assertMinorUnits(req.amount);
    const phone = normalizeGhanaPhone(req.phone).local;
    if (payoutsSent.has(req.reference)) throw new PesewaError("duplicate_reference", "Fake: duplicate payout reference", { provider: this.name });
    if (phone.endsWith("0000")) {
      payoutsSent.set(req.reference, { amount: req.amount, status: "failed" });
      return { provider: this.name, status: "failed", reference: req.reference, message: "Wallet not found (test number ending 0000)", raw: null };
    }
    payoutsSent.set(req.reference, { amount: req.amount, status: "pending" });
    return { provider: this.name, status: "pending", reference: req.reference, message: `Sending to ${phone}`, raw: null };
  }

  async verifyPayout(reference: string): Promise<Payout> {
    const payout = payoutsSent.get(reference);
    if (!payout) throw new PesewaError("not_found", "Fake: unknown payout", { provider: this.name });
    return {
      provider: this.name,
      reference,
      status: payout.status,
      amount: payout.amount,
      currency: "GHS",
      failureReason: payout.status === "failed" ? "Wallet rejected the transfer" : payout.status === "reversed" ? "Reversed by the wallet" : undefined,
      raw: null,
    };
  }

  async handlePayoutWebhook(req: WebhookRequest): Promise<Payout | null> {
    const event = this.event(req);
    return event.kind === "payout" ? this.verifyPayout(event.reference) : null;
  }

  /** What the provider "does" with a payout. `expectedAmount` re-creates one this process forgot. */
  settlePayout(reference: string, outcome: "success" | "failed" | "reversed", expectedAmount?: number): void {
    if (!payoutsSent.has(reference) && expectedAmount !== undefined) payoutsSent.set(reference, { amount: expectedAmount, status: "pending" });
    const payout = payoutsSent.get(reference);
    if (!payout) throw new PesewaError("not_found", "Fake: unknown payout");
    payout.status = outcome;
  }

  // ---- What the member "does" on their phone, and the provider's callback ----

  /**
   * Approves or declines a waiting payment. `paidAmount` simulates the member
   * paying a different amount. `expectedAmount` re-creates a payment this
   * process forgot (the dev server restarted while it was waiting).
   */
  settle(reference: string, outcome: "success" | "failed", paidAmount?: number, expectedAmount?: number): void {
    if (!payments.has(reference) && expectedAmount !== undefined) payments.set(reference, { amount: expectedAmount, status: "pending" });
    const payment = payments.get(reference);
    if (!payment) throw new PesewaError("not_found", "Fake: unknown reference");
    payment.status = outcome;
    payment.paidAmount = paidAmount;
  }

  /** The webhook the provider would send, signed. */
  webhookFor(reference: string, kind: "payment" | "payout" = "payment"): WebhookRequest {
    const body = JSON.stringify({ event: `${kind}.updated`, kind, reference, sentAt: Date.now() });
    return { body, headers: { "content-type": "application/json", [FAKE_SIGNATURE_HEADER]: sign(this.secret, body) } };
  }
}
