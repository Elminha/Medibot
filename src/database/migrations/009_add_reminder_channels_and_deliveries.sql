-- Canais que cada lembrete usa (navegador e/ou Telegram). Linha ausente para um
-- lembrete não existe depois do backfill abaixo: todo lembrete sempre tem pelo menos
-- uma linha aqui a partir desta migration. O backfill marca os lembretes já
-- existentes só com "browser", preservando o comportamento atual deles.
CREATE TABLE IF NOT EXISTS reminder_channels (
    reminder_id BIGINT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    PRIMARY KEY (reminder_id, channel)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reminder_channels_channel_check'
    ) THEN
        ALTER TABLE reminder_channels
            ADD CONSTRAINT reminder_channels_channel_check CHECK (channel IN ('browser', 'telegram'));
    END IF;
END $$;

INSERT INTO reminder_channels (reminder_id, channel)
SELECT id, 'browser' FROM reminders
ON CONFLICT (reminder_id, channel) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_reminder_channels_reminder_id
    ON reminder_channels (reminder_id);

-- Uma linha por ocorrência x canal efetivamente despachado PELO SERVIDOR (hoje só
-- "telegram": o canal "browser" nunca passa por aqui, é só o navegador do próprio
-- usuário, sem envio do servidor). occurrence_at é o instante absoluto (TIMESTAMPTZ)
-- já resolvido para UTC pela mesma lógica de wallTimeToEpoch usada no navegador —
-- guardar o instante, não data+hora local, evita qualquer ambiguidade de fuso/DST na
-- hora de comparar "já processei essa ocorrência?" e deixa o índice de unicidade
-- abaixo fazer a idempotência sem normalização adicional.
CREATE TABLE IF NOT EXISTS reminder_deliveries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reminder_id BIGINT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    occurrence_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reminder_deliveries_channel_check'
    ) THEN
        ALTER TABLE reminder_deliveries
            ADD CONSTRAINT reminder_deliveries_channel_check CHECK (channel IN ('telegram'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reminder_deliveries_status_check'
    ) THEN
        ALTER TABLE reminder_deliveries
            ADD CONSTRAINT reminder_deliveries_status_check
            CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped'));
    END IF;
END $$;

-- IDEMPOTÊNCIA: nenhuma ocorrência do mesmo lembrete+canal pode ser despachada duas
-- vezes, mesmo com execuções concorrentes do despachante (ver reminderDispatchService.ts).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_deliveries_unique_occurrence
    ON reminder_deliveries (reminder_id, channel, occurrence_at);

CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_status
    ON reminder_deliveries (status);

ALTER TABLE reminder_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_deliveries ENABLE ROW LEVEL SECURITY;
