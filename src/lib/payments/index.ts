import { MtnMomo, Paystack, isPayoutProvider, type MobileMoneyProvider, type PayoutProvider } from "pesewa";
import { FakeProvider } from "./fake";

// Which payment provider Susu talks to, from PAYMENTS_PROVIDER:
//   fake      (default) built-in test provider, no keys needed
//   paystack  Paystack TEST mode: PAYSTACK_SECRET_KEY must start with sk_test_
//   mtn_momo  MTN MoMo SANDBOX: MTN_MOMO_* keys, environment "sandbox"
//
// Susu is a demo, so live keys are refused outright. Holding real savings
// needs a Bank of Ghana licence.

export type ProviderName = "fake" | "paystack" | "mtn_momo";

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  fake: "Test payments",
  paystack: "Paystack (test mode)",
  mtn_momo: "MTN MoMo (sandbox)",
};

export class PaymentConfigError extends Error {
  readonly name = "PaymentConfigError";
}

export function configuredProviderName(): ProviderName {
  const name = (process.env.PAYMENTS_PROVIDER ?? "fake").trim() as ProviderName;
  if (!(name in PROVIDER_LABELS)) throw new PaymentConfigError(`Unknown PAYMENTS_PROVIDER "${name}". Use fake, paystack, or mtn_momo.`);
  return name;
}

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new PaymentConfigError(`${key} is not set.`);
  return value;
}

function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

const globalForPayments = globalThis as unknown as { paymentProviders?: Map<ProviderName, MobileMoneyProvider> };
const cache = (globalForPayments.paymentProviders ??= new Map());

function build(name: ProviderName): MobileMoneyProvider {
  switch (name) {
    case "fake":
      return new FakeProvider(process.env.FAKE_PAYMENTS_SECRET ?? "susu-dev-only-fake-secret");
    case "paystack": {
      const secretKey = required("PAYSTACK_SECRET_KEY");
      if (!secretKey.startsWith("sk_test_")) {
        throw new PaymentConfigError("Susu only runs on Paystack TEST keys (sk_test_...). Live keys are refused.");
      }
      return new Paystack({ secretKey });
    }
    case "mtn_momo": {
      const environment = process.env.MTN_MOMO_ENVIRONMENT?.trim() || "sandbox";
      if (environment !== "sandbox") throw new PaymentConfigError("Susu only runs on the MTN MoMo sandbox.");
      const disbursementKey = process.env.MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY?.trim();
      return new MtnMomo({
        subscriptionKey: required("MTN_MOMO_SUBSCRIPTION_KEY"),
        apiUser: required("MTN_MOMO_API_USER"),
        apiKey: required("MTN_MOMO_API_KEY"),
        environment,
        callbackUrl: `${appUrl()}/api/webhooks/mtn_momo`,
        // Payouts need MTN's separate Disbursement product; without it, pots go out in cash
        disbursement: disbursementKey
          ? {
              subscriptionKey: disbursementKey,
              apiUser: required("MTN_MOMO_DISBURSEMENT_API_USER"),
              apiKey: required("MTN_MOMO_DISBURSEMENT_API_KEY"),
            }
          : undefined,
      });
    }
  }
}

/**
 * The provider for a name, built once per process. Only the configured
 * provider is available, so a webhook can't be accepted for one that isn't.
 */
export function getProvider(name: string = configuredProviderName()): MobileMoneyProvider {
  if (name !== configuredProviderName()) throw new PaymentConfigError(`Provider "${name}" isn't enabled.`);
  const key = name as ProviderName;
  let provider = cache.get(key);
  if (!provider) {
    provider = build(key);
    cache.set(key, provider);
  }
  return provider;
}

/** The configured provider, if it can send payouts. */
export function getPayoutProvider(name: string = configuredProviderName()): (MobileMoneyProvider & PayoutProvider) | null {
  const provider = getProvider(name);
  if (!isPayoutProvider(provider)) return null;
  // MTN only pays out when its Disbursement keys are configured
  if (provider.name === "mtn_momo" && !process.env.MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY?.trim()) return null;
  return provider as MobileMoneyProvider & PayoutProvider;
}

export function getFakeProvider(): FakeProvider | null {
  return configuredProviderName() === "fake" ? (getProvider("fake") as FakeProvider) : null;
}

/** The MTN sandbox only accepts EUR; everywhere else it's cedis. */
export function currencyFor(name: string): string {
  return name === "mtn_momo" ? "EUR" : "GHS";
}
