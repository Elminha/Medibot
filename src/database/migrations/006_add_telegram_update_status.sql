-- Adiciona estado explícito a telegram_processed_updates para distinguir um update
-- "em processamento" (pode ter morrido no meio, ex.: timeout) de um "concluído" (não
-- deve ser reprocessado). Linhas já existentes (inseridas pelo código antigo, que trata
-- qualquer inserção como concluída) assumem o default 'done', preservando o
-- comportamento anterior para elas.
ALTER TABLE telegram_processed_updates
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'done';

ALTER TABLE telegram_processed_updates
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'telegram_processed_updates_status_check'
    ) THEN
        ALTER TABLE telegram_processed_updates
            ADD CONSTRAINT telegram_processed_updates_status_check CHECK (status IN ('processing', 'done'));
    END IF;
END $$;

-- Código antigo (ainda rodando durante o deploy) continua inserindo só
-- (update_id, chat_id); como `status` e `started_at` têm DEFAULT, essas linhas ficam
-- com status 'done' automaticamente, igual ao comportamento "insert-once" anterior.
