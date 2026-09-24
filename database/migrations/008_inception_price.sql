
ALTER TABLE mixer_allocations
    ADD COLUMN IF NOT EXISTS inception_price NUMERIC;

COMMENT ON COLUMN mixer_allocations.inception_price IS
    'USD price of this token when the mixer was created. Fixes the index''s denominator.';
