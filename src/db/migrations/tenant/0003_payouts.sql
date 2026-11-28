-- Payouts (a round's pot to its recipient, or a refund), cash deposits, and
-- reconciliation, inside each group's schema.

-- ---- Where each member wants their payout sent -----------------------------
-- Only the member can set this (the app enforces it), so a collector can't
-- quietly redirect someone else's pot to their own number.
CREATE TABLE payout_accounts (
  user_id    uuid PRIMARY KEY REFERENCES users (id),
  phone      text NOT NULL,
  network    text NOT NULL CHECK (network IN ('mtn', 'telecel', 'at')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Payouts -----------------------------------------------------------------
CREATE TABLE payouts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- round:  a round's pot to its recipient
  -- refund: money owed back (paid twice, or the wrong amount), to the number that paid it
  kind              text NOT NULL CHECK (kind IN ('round', 'refund')),
  round_id          uuid REFERENCES rounds (id),
  contribution_id   uuid REFERENCES contributions (id),
  recipient_user_id uuid NOT NULL REFERENCES users (id),
  amount_pesewas    bigint NOT NULL CHECK (amount_pesewas > 0),
  method            text NOT NULL CHECK (method IN ('momo', 'cash')),
  provider          text,
  -- A UUID v4, saved before the provider is called, and reused on every retry
  reference         text NOT NULL UNIQUE,
  phone             text,
  network           text CHECK (network IN ('mtn', 'telecel', 'at')),
  status            text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'reversed')),
  failure_reason    text,
  initiated_by      uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  settled_at        timestamptz,
  CHECK ((kind = 'round') = (round_id IS NOT NULL)),
  CHECK ((kind = 'refund') = (contribution_id IS NOT NULL)),
  CHECK ((method = 'cash') = (provider IS NULL)),
  CHECK (method = 'cash' OR phone IS NOT NULL)
);
-- The rule that matters most: a round's pot goes out at most once. A failed
-- attempt can be retried, but there's never more than one in flight or done.
CREATE UNIQUE INDEX payouts_one_per_round_key ON payouts (round_id) WHERE kind = 'round' AND status IN ('pending', 'succeeded');
CREATE UNIQUE INDEX payouts_one_per_refund_key ON payouts (contribution_id) WHERE kind = 'refund' AND status IN ('pending', 'succeeded');

CREATE FUNCTION payouts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payouts are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.kind, NEW.round_id, NEW.contribution_id, NEW.recipient_user_id, NEW.amount_pesewas, NEW.method, NEW.provider,
      NEW.reference, NEW.phone, NEW.network, NEW.initiated_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.kind, OLD.round_id, OLD.contribution_id, OLD.recipient_user_id, OLD.amount_pesewas, OLD.method, OLD.provider,
      OLD.reference, OLD.phone, OLD.network, OLD.initiated_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a payout''s details can''t change' USING ERRCODE = 'check_violation';
  END IF;
  -- pending -> succeeded | failed;  succeeded -> reversed;  failed and reversed are final
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed'))
     AND NOT (OLD.status = 'succeeded' AND NEW.status = 'reversed') THEN
    RAISE EXCEPTION 'a payout can''t go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payouts_guard BEFORE UPDATE OR DELETE ON payouts
  FOR EACH ROW EXECUTE FUNCTION payouts_guard();

-- ---- Cash moved into the provider balance ------------------------------------
-- A collector holding cash tops up the provider balance so a pot can go out
-- by MoMo. Each deposit is one ledger posting: clearing up, cash down.
CREATE TABLE cash_deposits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,
  amount_pesewas bigint NOT NULL CHECK (amount_pesewas > 0),
  note           text NOT NULL DEFAULT '',
  recorded_by    uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---- Reconciliation reports ------------------------------------------------------
CREATE TABLE reconciliation_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  ran_by      uuid REFERENCES users (id),
  checked     integer NOT NULL,
  matched     integer NOT NULL,
  fixed       integer NOT NULL,
  problems    integer NOT NULL,
  report      jsonb NOT NULL
);

-- ---- New ledger transaction kinds ------------------------------------------------
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check
  CHECK (kind IN ('contribution', 'refund_due', 'payout', 'payout_reversal', 'refund', 'refund_reversal', 'cash_deposit'));

-- ---- Rounds: "paid out" has to mean the money went ----------------------------
-- Replaces the guard from 0001. A round can only become paid_out from full,
-- with a succeeded payout on record, and only goes back to full if that
-- payout was reversed.
CREATE OR REPLACE FUNCTION rounds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cycle_status text;
BEGIN
  SELECT status INTO cycle_status FROM cycles
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.cycle_id ELSE NEW.cycle_id END;

  IF TG_OP IN ('INSERT', 'DELETE') THEN
    IF cycle_status IS NOT NULL AND cycle_status <> 'draft' THEN
      RAISE EXCEPTION 'the cycle has started: its schedule is fixed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF (NEW.id, NEW.cycle_id, NEW.number, NEW.due_on, NEW.recipient_user_id)
     IS DISTINCT FROM (OLD.id, OLD.cycle_id, OLD.number, OLD.due_on, OLD.recipient_user_id) THEN
    RAISE EXCEPTION 'round % is part of a fixed schedule and can''t change', OLD.number USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'paid_out' AND OLD.status <> 'paid_out' THEN
    IF OLD.status <> 'full' THEN
      RAISE EXCEPTION 'round % isn''t full, so it can''t be paid out', OLD.number USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM payouts WHERE round_id = NEW.id AND kind = 'round' AND status = 'succeeded') THEN
      RAISE EXCEPTION 'round % has no successful payout on record', OLD.number USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.status = 'paid_out' AND NEW.status <> 'paid_out' THEN
    IF NEW.status <> 'full'
       OR EXISTS (SELECT 1 FROM payouts WHERE round_id = NEW.id AND kind = 'round' AND status = 'succeeded')
       OR NOT EXISTS (SELECT 1 FROM payouts WHERE round_id = NEW.id AND kind = 'round' AND status = 'reversed') THEN
      RAISE EXCEPTION 'round % has been paid out and can only reopen if that payout was reversed', OLD.number USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---- Cycles: closing needs every round paid out --------------------------------
-- Replaces the guard from 0001 with one more rule at the end.
CREATE OR REPLACE FUNCTION cycles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  member_count integer;
  round_count  integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'cycle % has started and can''t be deleted', OLD.number USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'draft' AND (
       NEW.number, NEW.amount_pesewas, NEW.frequency, NEW.starts_on, NEW.order_method
     ) IS DISTINCT FROM (
       OLD.number, OLD.amount_pesewas, OLD.frequency, OLD.starts_on, OLD.order_method
     ) THEN
    RAISE EXCEPTION 'cycle % has started: its rules can''t change', OLD.number USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'draft' AND NEW.status = 'active')
     AND NOT (OLD.status = 'active' AND NEW.status = 'closed') THEN
    RAISE EXCEPTION 'cycle can''t go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'active' THEN
    SELECT count(*) INTO member_count FROM cycle_members WHERE cycle_id = NEW.id;
    SELECT count(*) INTO round_count FROM rounds WHERE cycle_id = NEW.id;
    IF member_count < 2 THEN
      RAISE EXCEPTION 'a cycle needs at least 2 members' USING ERRCODE = 'check_violation';
    END IF;
    IF round_count <> member_count
       OR (SELECT max(payout_position) FROM cycle_members WHERE cycle_id = NEW.id) <> member_count
       OR (SELECT max(number) FROM rounds WHERE cycle_id = NEW.id) <> member_count THEN
      RAISE EXCEPTION 'cycle % has an incomplete schedule', NEW.number USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'closed'
     AND EXISTS (SELECT 1 FROM rounds WHERE cycle_id = NEW.id AND status <> 'paid_out') THEN
    RAISE EXCEPTION 'cycle % still has rounds that haven''t been paid out', NEW.number USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;
