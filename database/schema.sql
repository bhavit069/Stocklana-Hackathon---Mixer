
CREATE DATABASE IF NOT EXISTS mixer;
USE mixer;

CREATE TABLE IF NOT EXISTS users (
    user_id           STRING PRIMARY KEY,
    username          STRING NOT NULL UNIQUE,
    email             STRING NOT NULL UNIQUE,
    password_hash     STRING,
    privy_wallet_id   STRING,
    wallet_address    STRING,

    auth_wallet_address STRING UNIQUE,
    referred_by       STRING,
    x_id              STRING UNIQUE,
    x_username        STRING,
    x_profile_picture STRING,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS token_info (
    address          STRING PRIMARY KEY,
    name             STRING,
    symbol           STRING,
    logo             STRING,
    decimals         INT,
    is_verified      BOOL NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ,
    detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    score_normalised INT,
    freeze_authority BOOL,
    mint_authority   BOOL,
    rugged           BOOL
);

CREATE INDEX IF NOT EXISTS token_info_detected_at_idx
    ON token_info (detected_at DESC);

CREATE TABLE IF NOT EXISTS token_watchlist (
    token_address STRING PRIMARY KEY,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mixers (
    mixer_id            STRING PRIMARY KEY,
    created_by          STRING REFERENCES users (user_id),
    name                STRING,
    ticker              STRING,
    image               STRING,
    description         STRING,

    category            STRING,

    thesis_title        STRING,
    thesis              STRING,

    parent_mixer_id     STRING REFERENCES mixers (mixer_id) ON DELETE SET NULL,

    counter_thesis      STRING,

    parent_name         STRING,
    parent_ticker       STRING,
    parent_snapshot     JSONB,

    initial_price       DECIMAL,
    mixer_authority_pda STRING,
    status              STRING NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'closed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mixers_status_created_at_idx
    ON mixers (status, created_at DESC);
CREATE INDEX IF NOT EXISTS mixers_created_by_idx
    ON mixers (created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS mixers_category_idx
    ON mixers (category, created_at DESC);

CREATE INDEX IF NOT EXISTS mixers_parent_idx
    ON mixers (parent_mixer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mixer_allocations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mixer_id      STRING NOT NULL REFERENCES mixers (mixer_id) ON DELETE CASCADE,

    token_address STRING NOT NULL,

    mirror_mint   STRING,
    vault_pda     STRING,
    weight        DECIMAL NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (mixer_id, token_address)
);

CREATE INDEX IF NOT EXISTS mixer_allocations_token_idx
    ON mixer_allocations (token_address);

CREATE TABLE IF NOT EXISTS mixer_candles (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mixer_id STRING NOT NULL,
    interval STRING NOT NULL,
    time     INT8 NOT NULL,
    open     DECIMAL NOT NULL,
    high     DECIMAL NOT NULL,
    low      DECIMAL NOT NULL,
    close    DECIMAL NOT NULL,
    UNIQUE (mixer_id, interval, time)
);

CREATE INDEX IF NOT EXISTS mixer_candles_lookup_idx
    ON mixer_candles (mixer_id, interval, time DESC);
