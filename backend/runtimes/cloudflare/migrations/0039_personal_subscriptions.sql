-- Individual-usage subscriptions (currently Claude). Unlike the per-workspace pool
-- (0035 provider_subscription_tokens), these are scoped to a single USER and never
-- pooled/rotated/shared — the subscription is licensed for that individual only.
--
-- The credential is DOUBLE-encrypted: the raw token is sealed under a key derived
-- from the user's personal PASSWORD (never stored), then encrypted again with the
-- system SecretCipher. Recovering it needs BOTH the system key AND the password.

CREATE TABLE personal_subscriptions (
  id            TEXT    NOT NULL,
  user_id       INTEGER NOT NULL,            -- GitHub user id of the owner
  vendor        TEXT    NOT NULL,            -- individual-usage vendor (e.g. 'claude')
  label         TEXT    NOT NULL,
  token_cipher  TEXT    NOT NULL,            -- system.encrypt(personal.seal(token, password))
  expires_at    INTEGER,                     -- subscription's own expiry (null = none)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER,                     -- last run activation (null = never)
  deleted_at    INTEGER,                     -- tombstone
  PRIMARY KEY (id)
);

-- One live credential per user+vendor; also the lookup the unlock/activate path uses.
CREATE UNIQUE INDEX idx_personal_subs_user_vendor
  ON personal_subscriptions (user_id, vendor)
  WHERE deleted_at IS NULL;

-- The renewal-nudge sweep scans live rows by expiry.
CREATE INDEX idx_personal_subs_expiry
  ON personal_subscriptions (expires_at)
  WHERE deleted_at IS NULL;

-- Per-run activation of a personal credential: the raw token re-encrypted with the
-- SYSTEM key only (no password layer), minted when the user supplies their password
-- at task start/retry, so the asynchronous container steps of that ONE run can use
-- it without the user present. Deleted when the run finishes; swept on TTL expiry.
CREATE TABLE subscription_activations (
  id            TEXT    NOT NULL,
  execution_id  TEXT    NOT NULL,            -- the run this activation is scoped to
  user_id       INTEGER NOT NULL,
  vendor        TEXT    NOT NULL,
  token_cipher  TEXT    NOT NULL,            -- system.encrypt(rawToken)
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,            -- activation TTL
  PRIMARY KEY (id)
);

-- Lease/refresh the activation for a run+user+vendor.
CREATE UNIQUE INDEX idx_sub_activations_run
  ON subscription_activations (execution_id, user_id, vendor);

-- The TTL-expiry sweep scans by expires_at.
CREATE INDEX idx_sub_activations_expiry
  ON subscription_activations (expires_at);
