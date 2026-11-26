-- What billing keeps, and all of it. No household id, address, phone number, e-mail or name; a
-- payment is known by the hash of its provider's reference, a license by the hash of its key. Times
-- are the server's, kept to the day, which is all reconciliation needs.

CREATE TABLE license (
  id_hash         TEXT PRIMARY KEY,
  plan            TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  -- bazaar, ipg, …
  source          TEXT NOT NULL,
  -- One payment makes one license, however often it is verified.
  source_ref_hash TEXT NOT NULL UNIQUE,
  slots_used      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- Each household a license has been signed for, as the client's own random nonce, hashed. The
-- nonce says nothing about which household it is.
CREATE TABLE redemption (
  slot_nonce_hash TEXT PRIMARY KEY,
  license_id_hash TEXT NOT NULL REFERENCES license(id_hash),
  created_at      INTEGER NOT NULL
);
CREATE INDEX redemption_license ON redemption(license_id_hash);
