-- Suporte a "esqueci minha senha": marca quando a senha foi trocada (para invalidar
-- tokens JWT emitidos antes da troca) e registra tokens/tentativas de redefinição.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- Guarda apenas o hash (sha256) do token de redefinição, nunca o token em texto puro.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
    ON password_reset_tokens (user_id);

-- email_hash/ip_hash nunca guardam o valor em texto puro (HMAC-SHA256 com JWT_SECRET,
-- calculado pela aplicação). kind diferencia o limite de pedido ("request") do limite
-- de confirmação ("confirm"), que têm janelas/colunas de contagem diferentes.
CREATE TABLE IF NOT EXISTS password_reset_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email_hash TEXT,
    ip_hash TEXT,
    kind TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'password_reset_attempts_kind_check'
    ) THEN
        ALTER TABLE password_reset_attempts
            ADD CONSTRAINT password_reset_attempts_kind_check CHECK (kind IN ('request', 'confirm'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_password_reset_attempts_email_hash_created_at
    ON password_reset_attempts (email_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_password_reset_attempts_ip_hash_created_at
    ON password_reset_attempts (ip_hash, created_at);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_attempts ENABLE ROW LEVEL SECURITY;
