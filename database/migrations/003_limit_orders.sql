
CREATE TABLE IF NOT EXISTS limit_orders (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      STRING NOT NULL REFERENCES users (user_id),
    mixer_id     STRING NOT NULL,
    wallet       STRING NOT NULL,
    side         STRING NOT NULL CHECK (side IN ('buy', 'sell')),

    amount       DECIMAL NOT NULL,
    trigger_price DECIMAL NOT NULL,

    status       STRING NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'filled', 'cancelled', 'failed')),
    last_error   STRING,
    fill_price   DECIMAL,
    signatures   JSONB,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    filled_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS limit_orders_open_idx
    ON limit_orders (mixer_id, status);
CREATE INDEX IF NOT EXISTS limit_orders_user_idx
    ON limit_orders (user_id, created_at DESC);
