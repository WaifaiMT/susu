# Susu

[![CI](https://github.com/WaifaiMT/susu/actions/workflows/ci.yml/badge.svg)](https://github.com/WaifaiMT/susu/actions/workflows/ci.yml)

An open-source app for running **susu groups**: the rotating savings groups used across Ghana and West Africa. Everyone pays the same amount each round, one member takes the whole pot, and the order rotates until everyone has been paid once.

Built with **Next.js 16, TypeScript, and PostgreSQL**. Being built in public: see the [roadmap](#roadmap).

> ⚠️ **A demo and learning project, not a live money service.** It runs on test and sandbox payment keys only. Collecting and holding other people's savings for real needs a licence from the Bank of Ghana.

## What a susu is

Five traders agree to pay GH₵ 50 every week. Each week one of them receives GH₵ 250. After five weeks, everyone has paid in GH₵ 250 and received GH₵ 250. That's one **cycle**. Nobody earns interest; the value is getting a lump sum early, and the discipline of saving with people you know.

It runs on trust, so arguments start when the rules move: "the amount was GH₵ 40 when I joined", "it was supposed to be my turn". This app's main job is to make the rules **impossible to change once a cycle starts**.

## What works today

| | |
|---|---|
| **Groups** | Each susu group is a tenant with its **own PostgreSQL schema**, so one group's data can't reach another's |
| **Roles** | **Collector** runs the group and sets the rules · **Treasurer** helps (invites, audit log) but can't change the rules · **Member** pays in and gets paid out |
| **Cycles** | Draft a cycle: contribution amount, daily/weekly/monthly, first due date, and a payout order (random draw or join order), then rearrange it by hand |
| **Locked schedule** | Starting a cycle generates every round's date and recipient. From then on the amount, dates and order are **locked by the database itself** |
| **Money** | Every amount is an integer number of **pesewas**, never a float |
| **Audit log** | Every draft, reorder, shuffle and start is recorded in the same transaction as the change |
| **Invites** | Single-use, expiring links tied to an email, stored hashed |

## How the rules are enforced

The app checks the rules and shows friendly errors. But a check in application code only protects you from the paths you remembered. So the same rules are also **triggers and constraints in PostgreSQL** ([`0001_cycles.sql`](src/db/migrations/tenant/0001_cycles.sql)), and they hold even for a raw `UPDATE` typed into `psql`:

```mermaid
stateDiagram-v2
    [*] --> draft: collector drafts
    draft --> draft: reorder / shuffle
    draft --> [*]: discard
    draft --> active: start (needs 2+ members and a complete schedule)
    active --> closed: everyone paid out
    note right of active
      amount, dates, frequency: locked
      members and payout order: locked
      rounds: only their status can move forward
      can't be deleted or sent back to draft
    end note
```

| Rule | Enforced by |
|---|---|
| One open cycle per group, even if two requests race | Partial unique index on `cycles` |
| Started cycle's amount, dates, frequency can't change | `cycles_guard` trigger |
| Started cycle's members and order can't change | `cycle_members_guard` trigger |
| Rounds can't be moved, reassigned, added, or deleted; a paid-out round never reopens | `rounds_guard` trigger |
| A cycle can only start with a complete schedule | `cycles_guard` checks members = rounds = positions 1..n |
| Nobody gets two payouts in one cycle | `UNIQUE (cycle_id, recipient_user_id)` on `rounds` |
| Two members can swap places | Deferred unique constraint on payout positions |

The [tests](tests/cycles.test.ts) try to break each rule with raw SQL and assert that Postgres refuses.

## Roadmap

- [x] **Week 1:** groups, roles, drafting and starting cycles, the locked schedule
- [ ] **Week 2:** pay contributions with Mobile Money ([pesewa](https://github.com/WaifaiMT/pesewa): Paystack test mode, MTN MoMo sandbox), verified webhooks, a **double-entry ledger**
- [ ] **Week 3:** payouts that can't happen twice, failed and reversed transfers, daily **reconciliation** against the provider
- [ ] **Week 4:** demo data, screenshots, and a wiki: architecture, how money moves, idempotency, threat model, what broke

Work is tracked in [issues](https://github.com/WaifaiMT/susu/issues).

## Run it locally

You need Node.js 20.9+ and PostgreSQL 14+ (local, or `docker compose up -d`).

```bash
cp .env.example .env      # point DATABASE_URL at your database
npm install
npm run db:migrate
npm run db:seed           # two demo groups: one running, one being drafted
npm run dev
```

Sign in as `ama@example.com` (collector of the running group) or `kofi@example.com` (collector of the draft), password `password1234`.

```bash
npm test          # integration tests against a throwaway PostgreSQL database
npm run lint
npm run typecheck
```

## How it's built

```
public schema (shared)                 org_<id> schema (one per group)
├── users, sessions                    ├── cycles          amount, frequency, start, status
├── organizations (groups)             ├── cycle_members   who's in, payout position
├── memberships (role)                 ├── rounds          due date, recipient, status
├── invites                            └── _migrations
└── audit_log
```

- Every group query runs through `withTenant()`, which opens a transaction and sets `search_path` to that group's schema with `SET LOCAL`, so a pooled connection never carries one group into the next request.
- `src/lib/services/` holds the business logic; pages and server actions only call it. Every service takes an `OrgContext` (who, which group, which role) and checks permissions from one map in `src/lib/permissions.ts`.
- Dates are calendar dates. Ghana is on GMT all year, so UTC is the group's local time. Monthly rounds keep their day and fall back to the month's last day (31 Jan → 28 Feb → 31 Mar).

Based on my [saas-starter](https://github.com/WaifaiMT/saas-starter) (schema-per-tenant, auth, roles, invites, audit log).

## License

[MIT](LICENSE) © Gilbert Addai Gyan
