
CREATE TABLE IF NOT EXISTS fee_claims (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           STRING NOT NULL REFERENCES users (user_id),
    mixer_id          STRING NOT NULL,
    mint              STRING NOT NULL,
    token_amount      DECIMAL NOT NULL,
    lamports          INT8 NOT NULL,
    claim_signature   STRING NOT NULL,
    status            STRING NOT NULL DEFAULT 'unpaid'
        CHECK (status IN ('unpaid', 'paid')),
    payout_signature  STRING,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS fee_claims_user_idx
    ON fee_claims (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS fee_claims_mixer_idx
    ON fee_claims (mixer_id, created_at DESC);
