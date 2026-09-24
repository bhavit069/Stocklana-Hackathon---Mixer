
CREATE TABLE IF NOT EXISTS mirror_mints (
    real_mint     TEXT PRIMARY KEY,
    mirror_mint   TEXT NOT NULL UNIQUE,
    decimals      INT  NOT NULL,
    token_program TEXT NOT NULL,

    rate          NUMERIC,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mirror_mints_mirror_idx ON mirror_mints (mirror_mint);

ALTER TABLE mixer_allocations ADD COLUMN IF NOT EXISTS mirror_mint TEXT;
