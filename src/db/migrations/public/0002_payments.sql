-- Payment providers call one webhook URL for every group, so these two
-- tables live in the shared schema.

-- Which group a payment belongs to. The provider only sends back our
-- reference, so this is how a webhook finds the right tenant schema.
CREATE TABLE payment_references (
  provider        text NOT NULL,
  reference       text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, reference)
);

-- Every authenticated webhook, recorded once. Providers retry deliveries,
-- so the same event arriving twice is normal: the second insert conflicts
-- and the event is ignored.
CREATE TABLE webhook_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider    text NOT NULL,
  event_key   text NOT NULL,
  reference   text,
  outcome     text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_key)
);
