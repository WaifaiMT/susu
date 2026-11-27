// Tenant schema names are generated from organisation ids, never from user
// input, and checked against a strict pattern before they reach any SQL.
const TENANT_SCHEMA = /^org_[0-9a-f]{32}$/;

export function tenantSchemaName(organizationId: string): string {
  const schema = `org_${organizationId.replace(/-/g, "").toLowerCase()}`;
  assertTenantSchema(schema);
  return schema;
}

export function assertTenantSchema(schema: string): void {
  if (!TENANT_SCHEMA.test(schema)) {
    throw new Error(`Invalid tenant schema name: ${JSON.stringify(schema)}`);
  }
}

/** Quotes a Postgres identifier. Only used for schema names that already passed validation. */
export function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
