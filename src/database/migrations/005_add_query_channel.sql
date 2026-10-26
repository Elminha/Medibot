ALTER TABLE queries
    ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'site';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'queries_channel_check'
    ) THEN
        ALTER TABLE queries
            ADD CONSTRAINT queries_channel_check CHECK (channel IN ('site', 'telegram'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_queries_user_id_created_at
    ON queries (user_id, created_at DESC);
