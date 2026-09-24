
ALTER TABLE mixers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE mixers ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
ALTER TABLE mixers ADD COLUMN IF NOT EXISTS duration_ms INT8;
ALTER TABLE mixers ADD COLUMN IF NOT EXISTS composition_key STRING;

CREATE INDEX IF NOT EXISTS mixers_expiry_idx
    ON mixers (expires_at, settled_at);

CREATE INDEX IF NOT EXISTS mixers_composition_idx
    ON mixers (composition_key);
