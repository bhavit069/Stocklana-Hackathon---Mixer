
CREATE TABLE IF NOT EXISTS mixer_trades (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       STRING NOT NULL REFERENCES users (user_id),
    mixer_id      STRING NOT NULL,
    wallet        STRING NOT NULL,
    side          STRING NOT NULL DEFAULT 'buy'
        CHECK (side IN ('buy', 'sell')),
    sol_amount    DECIMAL NOT NULL,
    shares_delta  DECIMAL NOT NULL,
    shares_after  DECIMAL NOT NULL,
    price_usd     DECIMAL,
    signatures    JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mixer_trades_user_idx
    ON mixer_trades (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mixer_trades_mixer_idx
    ON mixer_trades (mixer_id, created_at DESC);
