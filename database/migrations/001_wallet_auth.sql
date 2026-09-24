
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_wallet_address STRING;

CREATE UNIQUE INDEX IF NOT EXISTS users_auth_wallet_address_key
    ON users (auth_wallet_address)
    WHERE auth_wallet_address IS NOT NULL;
