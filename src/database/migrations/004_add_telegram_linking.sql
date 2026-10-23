ALTER TABLE users
    ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;

-- Índice parcial: permite múltiplos usuários com telegram_chat_id NULL (não vinculados),
-- mas garante que um mesmo chat nunca fique vinculado a mais de uma conta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_chat_id_unique
    ON users (telegram_chat_id)
    WHERE telegram_chat_id IS NOT NULL;

-- Guarda apenas o hash (sha256) do código de vínculo, nunca o código em texto puro.
CREATE TABLE IF NOT EXISTS telegram_link_codes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_user_id
    ON telegram_link_codes (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_link_codes_code_hash_unique
    ON telegram_link_codes (code_hash);

-- Registro de updates do Telegram já processados: permite ignorar reenvios do
-- mesmo update_id (Telegram reenvia se o webhook não responder a tempo) de forma
-- simples e compartilhada entre instâncias serverless (sem estado em memória).
CREATE TABLE IF NOT EXISTS telegram_processed_updates (
    update_id BIGINT PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_chat_id
    ON telegram_processed_updates (chat_id);
