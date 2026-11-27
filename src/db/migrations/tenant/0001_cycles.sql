-- Runs inside each group's schema (search_path is set by the migrator), so
-- table names are unqualified.
--
-- A cycle is one full rotation: every member pays `amount` each round, and
-- each round one member receives the whole pot, until everyone has received
-- once. The rules below are enforced here, in the database, so no code path
-- (a bug, a script, a hand-written query) can break them.

CREATE TABLE cycles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         integer NOT NULL UNIQUE CHECK (number >= 1),
  -- Money is always an integer number of pesewas (GHS 1 = 100 pesewas), never a float
  amount_pesewas bigint NOT NULL CHECK (amount_pesewas BETWEEN 100 AND 100000000),
  frequency      text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  starts_on      date NOT NULL,
  order_method   text NOT NULL CHECK (order_method IN ('join_order', 'random', 'manual')),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  closed_at      timestamptz
);
-- At most one cycle being set up or running at a time
CREATE UNIQUE INDEX cycles_one_open_key ON cycles ((true)) WHERE status IN ('draft', 'active');

CREATE TABLE cycle_members (
  cycle_id        uuid NOT NULL REFERENCES cycles (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id),
  payout_position integer NOT NULL CHECK (payout_position >= 1),
  PRIMARY KEY (cycle_id, user_id),
  -- Deferred, so two members can swap places inside one transaction
  CONSTRAINT cycle_members_position_key UNIQUE (cycle_id, payout_position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rounds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id          uuid NOT NULL REFERENCES cycles (id) ON DELETE CASCADE,
  number            integer NOT NULL CHECK (number >= 1),
  due_on            date NOT NULL,
  recipient_user_id uuid NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'full', 'paid_out')),
  UNIQUE (cycle_id, number),
  -- Everyone receives exactly once per cycle
  UNIQUE (cycle_id, recipient_user_id),
  FOREIGN KEY (cycle_id, recipient_user_id) REFERENCES cycle_members (cycle_id, user_id)
);

-- ---- Rule 1: a cycle's rules are locked once it starts --------------------

CREATE FUNCTION cycles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

  -- Starting needs a complete schedule: 2+ members in positions 1..n, one round each
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

  RETURN NEW;
END $$;

CREATE TRIGGER cycles_guard BEFORE UPDATE OR DELETE ON cycles
  FOR EACH ROW EXECUTE FUNCTION cycles_guard();

-- ---- Rule 2: members and payout order only change while drafting ----------

CREATE FUNCTION cycle_members_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cycle_status text;
BEGIN
  SELECT status INTO cycle_status FROM cycles
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.cycle_id ELSE NEW.cycle_id END;
  -- NULL means the cycle itself is being deleted (only allowed for drafts)
  IF cycle_status IS NOT NULL AND cycle_status <> 'draft' THEN
    RAISE EXCEPTION 'the cycle has started: members and payout order are locked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER cycle_members_guard BEFORE INSERT OR UPDATE OR DELETE ON cycle_members
  FOR EACH ROW EXECUTE FUNCTION cycle_members_guard();

-- ---- Rule 3: the schedule is fixed; only a round's status can move forward -

CREATE FUNCTION rounds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- open -> full -> paid_out; a paid-out round never reopens
  IF OLD.status = 'paid_out' AND NEW.status <> 'paid_out' THEN
    RAISE EXCEPTION 'round % has been paid out and can''t reopen', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER rounds_guard BEFORE INSERT OR UPDATE OR DELETE ON rounds
  FOR EACH ROW EXECUTE FUNCTION rounds_guard();
