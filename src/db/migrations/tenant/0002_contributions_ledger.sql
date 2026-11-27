-- Contributions and the double-entry ledger, inside each group's schema.

-- ---- Contributions ---------------------------------------------------------
-- One row per payment attempt. A member may need several attempts for a
-- round (a declined prompt, a wrong number), but only one can succeed.

CREATE TABLE contributions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id           uuid NOT NULL REFERENCES rounds (id),
  user_id            uuid NOT NULL REFERENCES users (id),
  amount_pesewas     bigint NOT NULL CHECK (amount_pesewas > 0),
  method             text NOT NULL CHECK (method IN ('momo', 'cash')),
  -- 'fake' in development, 'paystack' or 'mtn_momo' with real (test) keys; NULL for cash
  provider           text,
  -- Our reference: a UUID v4, sent to the provider (MTN uses it as its request id)
  reference          text NOT NULL UNIQUE,
  phone              text,
  network            text CHECK (network IN ('mtn', 'telecel', 'at')),
  -- pending:       prompt sent, waiting for the member to approve
  -- otp_required:  waiting for the OTP the member received
  -- succeeded:     paid, counted towards the round
  -- duplicate:     paid, but the member had already paid this round: owed back
  -- mismatch:      paid, but not the expected amount: owed back
  -- failed:        declined, cancelled, or rejected by the provider
  -- expired:       abandoned; a newer attempt replaced it
  status             text NOT NULL CHECK (status IN ('pending', 'otp_required', 'succeeded', 'duplicate', 'mismatch', 'failed', 'expired')),
  received_pesewas   bigint,
  failure_reason     text,
  recorded_by        uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz,
  CHECK ((method = 'cash') = (provider IS NULL)),
  CHECK (method = 'cash' OR phone IS NOT NULL)
);
CREATE INDEX contributions_round_idx ON contributions (round_id);

-- At most one successful contribution per member per round
CREATE UNIQUE INDEX contributions_one_success_key ON contributions (round_id, user_id) WHERE status = 'succeeded';
-- At most one attempt waiting on the member at a time (two tabs can't send two prompts)
CREATE UNIQUE INDEX contributions_one_waiting_key ON contributions (round_id, user_id) WHERE status IN ('pending', 'otp_required');

CREATE FUNCTION contributions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contributions are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.round_id, NEW.user_id, NEW.amount_pesewas, NEW.method, NEW.provider, NEW.reference, NEW.phone, NEW.network, NEW.recorded_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.round_id, OLD.user_id, OLD.amount_pesewas, OLD.method, OLD.provider, OLD.reference, OLD.phone, OLD.network, OLD.recorded_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a contribution''s details can''t change' USING ERRCODE = 'check_violation';
  END IF;
  -- Money that arrived stays arrived. Reversals (week 3) are new ledger entries, not edits.
  IF OLD.status IN ('succeeded', 'duplicate', 'mismatch') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'contribution % was paid and can''t change status', OLD.reference USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER contributions_guard BEFORE UPDATE OR DELETE ON contributions
  FOR EACH ROW EXECUTE FUNCTION contributions_guard();

-- ---- Double-entry ledger ---------------------------------------------------
-- Every movement of money is a transaction of two or more entries that sum
-- to zero. Debits are positive, credits negative, all in pesewas.
--
--   clearing:<provider>  money held at the payment provider (asset)
--   cash                 cash the collector is holding (asset)
--   round:<round id>     the pot for one round (owed to that round's recipient)
--   refunds_due          money received that has to go back (duplicates, wrong amounts)

CREATE TABLE ledger_accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('contribution', 'refund_due')),
  -- What caused it (a contribution id). Each source posts once, however often it's processed.
  source_id  uuid NOT NULL,
  memo       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, source_id)
);

CREATE TABLE ledger_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions (id),
  account_id     uuid NOT NULL REFERENCES ledger_accounts (id),
  amount_pesewas bigint NOT NULL CHECK (amount_pesewas <> 0),
  member_user_id uuid REFERENCES users (id)
);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id);

-- The ledger is append-only
CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the ledger is append-only: post a correcting transaction instead' USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- Every transaction balances. Checked at COMMIT (deferred), once all its
-- entries are in, so code can insert entries one at a time.
CREATE FUNCTION ledger_assert_balanced(tx_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  total   bigint;
  entries integer;
BEGIN
  SELECT coalesce(sum(amount_pesewas), 0), count(*) INTO total, entries
    FROM ledger_entries WHERE transaction_id = tx_id;
  IF entries < 2 THEN
    RAISE EXCEPTION 'ledger transaction % needs at least two entries', tx_id USING ERRCODE = 'check_violation';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % doesn''t balance: entries sum to % pesewas', tx_id, total USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- One trigger function per table: PL/pgSQL can't read NEW.transaction_id on a
-- ledger_transactions row, even in a branch that never runs.
CREATE FUNCTION ledger_entries_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_balanced(NEW.transaction_id);
  RETURN NULL;
END $$;

CREATE FUNCTION ledger_transactions_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_balanced(NEW.id);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balance AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entries_balanced();
CREATE CONSTRAINT TRIGGER ledger_transactions_balance AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_transactions_balanced();
