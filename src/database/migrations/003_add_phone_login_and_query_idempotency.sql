-- Telefones legados não são convertidos automaticamente: não existe prova de
-- que foram verificados e uma heurística poderia tomar a conta de outra pessoa.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_e164 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_e164_unique
    ON users (phone_e164) WHERE phone_e164 IS NOT NULL;

-- Impede que o mesmo retry de uma consulta crie mais de um histórico.
ALTER TABLE queries ADD COLUMN IF NOT EXISTS request_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_queries_user_request_id_unique
    ON queries (user_id, request_id) WHERE request_id IS NOT NULL;
