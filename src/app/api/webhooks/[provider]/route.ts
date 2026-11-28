import { processWebhook } from "@/lib/services/webhooks";


// One endpoint per provider: /api/webhooks/paystack, /api/webhooks/mtn_momo.
// The body is read as raw text, because signatures are computed over the
// exact bytes the provider sent. Re-serialised JSON wouldn't match.
//
// Responses: 200 once the event is recorded (including duplicates and
// payments we don't know, so the provider stops retrying), 401 for a bad
// signature, 404 for a provider that isn't enabled, and 500 if something
// failed, so the provider tries again later.

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const body = await request.text();
  const result = await processWebhook(provider, { body, headers: request.headers, url: request.url });
  return Response.json({ outcome: result.outcome }, { status: result.status });
}
