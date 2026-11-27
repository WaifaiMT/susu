import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PesewaError,
  assertMinorUnits,
  normalizeGhanaPhone,
  type CollectRequest,
  type CollectResult,
  type MobileMoneyProvider,
  type Payment,
  type WebhookRequest,
} from "pesewa";

// A stand-in payment provider for development, demos and tests, so the
// whole payment flow runs with no keys, no account, and no money. It behaves
// like a real one where it matters: collect() only starts a payment, the
// outcome arrives later as a signed webhook, and handleWebhook() checks the
// signature and then asks verify() for the truth.
//
// Test numbers (any network prefix):
//   ...0000  declined straight away
//   ...1111  asks for an OTP; the OTP is 123456
//   anything else: a prompt is "sent"; approve or decline it from the page
//
// State lives in this process's memory, so it's lost on restart. Dev only.

export const FAKE_OTP = "123456";
export const FAKE_SIGNATURE_HEADER = "x-fake-signature";

type FakePayment = { amount: number; status: "pending" | "otp_required" | "success" | "failed"; paidAmount?: number };

const globalForFake = globalThis as unknown as { fakePayments?: Map<string, FakePayment> };
const payments = (globalForFake.fakePayments ??= new Map());

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export class FakeProvider implements MobileMoneyProvider {
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
    const headers = req.headers instanceof Headers ? Object.fromEntries(req.headers) : req.headers;
    const given = String(headers[FAKE_SIGNATURE_HEADER] ?? "");
    const expected = sign(this.secret, req.body);
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      throw new PesewaError("invalid_webhook", "Fake: bad signature", { provider: this.name });
    }
    let reference: unknown;
    try {
      reference = (JSON.parse(req.body) as { reference?: unknown }).reference;
    } catch {
      throw new PesewaError("invalid_webhook", "Fake: body isn't JSON", { provider: this.name });
    }
    if (typeof reference !== "string") throw new PesewaError("invalid_webhook", "Fake: no reference", { provider: this.name });
    // Never trust the body: confirm with verify(), like the real providers
    return this.verify(reference);
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
  webhookFor(reference: string): WebhookRequest {
    const body = JSON.stringify({ event: "payment.updated", reference, sentAt: Date.now() });
    return { body, headers: { "content-type": "application/json", [FAKE_SIGNATURE_HEADER]: sign(this.secret, body) } };
  }
}
