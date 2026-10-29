-- Expande lembretes para múltiplos horários e dias da semana, sem remover as colunas
-- antigas (reminders.time / reminders.frequency): o código novo continua escrevendo
-- nelas (primeiro horário e uma frequência equivalente) para que um rollback do
-- código para a versão anterior continue funcionando. A remoção de time/frequency
-- fica para uma migration futura, só depois que nada mais ler essas colunas.
ALTER TABLE reminders
    ALTER COLUMN "time" DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS starts_on DATE,
    ADD COLUMN IF NOT EXISTS ends_on DATE;

-- Backfill de starts_on para lembretes já existentes (usa a data de criação; nenhum
-- lembrete antigo tinha vigência, então isso só preenche a coluna nova sem mudar
-- comportamento).
UPDATE reminders SET starts_on = created_at::date WHERE starts_on IS NULL;

ALTER TABLE reminders
    ALTER COLUMN starts_on SET DEFAULT CURRENT_DATE,
    ALTER COLUMN starts_on SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reminders_ends_on_check'
    ) THEN
        ALTER TABLE reminders
            ADD CONSTRAINT reminders_ends_on_check CHECK (ends_on IS NULL OR ends_on >= starts_on);
    END IF;
END $$;

-- Um lembrete pode ter vários horários (1 a 12, validado na aplicação).
CREATE TABLE IF NOT EXISTS reminder_times (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reminder_id BIGINT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    "time" TIME NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_times_reminder_time_unique
    ON reminder_times (reminder_id, "time");

CREATE INDEX IF NOT EXISTS idx_reminder_times_reminder_id
    ON reminder_times (reminder_id);

-- Dias da semana em que o lembrete dispara (0=domingo .. 6=sábado, igual a
-- Date.getDay no navegador). Nenhuma linha = todos os dias.
CREATE TABLE IF NOT EXISTS reminder_weekdays (
    reminder_id BIGINT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    weekday SMALLINT NOT NULL,
    PRIMARY KEY (reminder_id, weekday)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reminder_weekdays_weekday_check'
    ) THEN
        ALTER TABLE reminder_weekdays
            ADD CONSTRAINT reminder_weekdays_weekday_check CHECK (weekday BETWEEN 0 AND 6);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_reminder_weekdays_reminder_id
    ON reminder_weekdays (reminder_id);

-- Converte os lembretes existentes para o novo formato (idempotente: pode rodar de
-- novo sem duplicar nem reverter uma pausa feita manualmente entre as execuções).
-- daily -> mantém sem dias (todos os dias). weekdays -> seg a sex (1..5).
INSERT INTO reminder_times (reminder_id, "time")
SELECT r.id, r."time"
FROM reminders r
WHERE r."time" IS NOT NULL
ON CONFLICT (reminder_id, "time") DO NOTHING;

INSERT INTO reminder_weekdays (reminder_id, weekday)
SELECT r.id, wd.weekday
FROM reminders r
CROSS JOIN (VALUES (1), (2), (3), (4), (5)) AS wd(weekday)
WHERE r.frequency = 'weekdays'
ON CONFLICT (reminder_id, weekday) DO NOTHING;

-- weekly/custom nunca disparavam notificação de verdade (o agendador antigo só
-- reconhece daily/weekdays). Para não passarem a notificar sem o usuário pedir,
-- ficam pausados (active=false) e sem dias definidos até o usuário revisar e salvar
-- de novo pela tela nova.
UPDATE reminders
SET active = false
WHERE frequency IN ('weekly', 'custom') AND active = true;

ALTER TABLE reminder_times ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_weekdays ENABLE ROW LEVEL SECURITY;
