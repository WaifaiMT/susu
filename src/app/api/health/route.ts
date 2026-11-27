import { connection } from "next/server";
import { getPool } from "@/db/client";

// Used by load balancers and deploy health checks (see vps-deploy-playbook).
export async function GET() {
  await connection(); // always run at request time, never prerendered
  try {
    await getPool().query("SELECT 1");
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, error: "database unavailable" }, { status: 503 });
  }
}
