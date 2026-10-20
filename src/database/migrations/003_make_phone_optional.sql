ALTER TABLE users
    ALTER COLUMN phone DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_email_or_phone'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT chk_users_email_or_phone
            CHECK (email IS NOT NULL OR phone IS NOT NULL) NOT VALID;
    END IF;
END $$;
