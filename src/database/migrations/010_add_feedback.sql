-- Feedback enviado por usuários logados através do botão flutuante do app. "view" é
-- só a tela atual (chat/historico/medicamentos/lembretes/telegram) e "device" é só
-- mobile/desktop — nada além disso é anexado automaticamente (ver feedbackRoutes.ts).
CREATE TABLE IF NOT EXISTS feedback (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    rating SMALLINT,
    message TEXT NOT NULL,
    view TEXT NOT NULL,
    device TEXT NOT NULL,
    contact_ok BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'novo',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'feedback_type_check'
    ) THEN
        ALTER TABLE feedback
            ADD CONSTRAINT feedback_type_check CHECK (type IN ('bug', 'sugestao', 'elogio', 'outro'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'feedback_rating_check'
    ) THEN
        ALTER TABLE feedback
            ADD CONSTRAINT feedback_rating_check CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'feedback_message_check'
    ) THEN
        ALTER TABLE feedback
            ADD CONSTRAINT feedback_message_check CHECK (char_length(message) BETWEEN 1 AND 2000);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'feedback_view_check'
    ) THEN
        ALTER TABLE feedback
            ADD CONSTRAINT feedback_view_check
            CHECK (view IN ('chat', 'historico', 'medicamentos', 'lembretes', 'telegram'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'feedback_device_check'
    ) THEN
        ALTER TABLE feedback
            ADD CONSTRAINT feedback_device_check CHECK (device IN ('mobile', 'desktop'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'feedback_status_check'
    ) THEN
        ALTER TABLE feedback
            ADD CONSTRAINT feedback_status_check
            CHECK (status IN ('novo', 'em_analise', 'resolvido', 'descartado'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
