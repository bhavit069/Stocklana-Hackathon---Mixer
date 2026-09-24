
ALTER TABLE mixers ADD COLUMN IF NOT EXISTS thesis_title TEXT;
ALTER TABLE mixers ADD COLUMN IF NOT EXISTS thesis TEXT;
ALTER TABLE mixers ADD COLUMN IF NOT EXISTS counter_thesis TEXT;

ALTER TABLE mixers ADD COLUMN IF NOT EXISTS parent_mixer_id TEXT
    REFERENCES mixers (mixer_id) ON DELETE SET NULL;

ALTER TABLE mixers ADD COLUMN IF NOT EXISTS parent_name TEXT;
ALTER TABLE mixers ADD COLUMN IF NOT EXISTS parent_ticker TEXT;

ALTER TABLE mixers ADD COLUMN IF NOT EXISTS parent_snapshot JSONB;

CREATE INDEX IF NOT EXISTS mixers_parent_idx
    ON mixers (parent_mixer_id, created_at DESC);

ALTER TABLE mixers ADD COLUMN IF NOT EXISTS category TEXT;
CREATE INDEX IF NOT EXISTS mixers_category_idx
    ON mixers (category, created_at DESC);
