-- Verificação obrigatória de e-mail: contas não verificadas continuam autenticando
-- (para ver a tela de confirmação e pedir reenvio), mas rotas protegidas bloqueiam
-- com 403 EMAIL_NOT_VERIFIED enquanto email_verified_at for NULL e a conta tiver
-- e-mail (ver requireVerifiedEmail em authMiddleware.ts). Contas existentes ficam
-- com email_verified_at NULL: não há como provar retroativamente que o dono do
-- e-mail cadastrado é quem diz ser, então elas precisam verificar no próximo login.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Mesmo padrão de password_reset_tokens (migration 007): só o hash (sha256) do
-- token, nunca o valor em texto puro.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id
    ON email_verification_tokens (user_id);

-- Limite de reenvio (3/hora e 10/dia por usuário, ver emailVerificationService.ts).
-- Por user_id (já autenticado), não por e-mail/IP em texto puro: diferente de
-- password_reset_attempts, não há necessidade de hash aqui.
CREATE TABLE IF NOT EXISTS email_verification_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_verification_attempts_user_id_created_at
    ON email_verification_attempts (user_id, created_at);

-- Limite de tomada de cadastro por e-mail-alvo (3/hora e 10/dia, ver authService.ts),
-- para ninguém conseguir ficar tentando se cadastrar repetidamente com o e-mail de
-- outra pessoa e invalidar o token de verificação dela. email_hash é HMAC-SHA256 com
-- JWT_SECRET (mesma técnica de password_reset_attempts.email_hash), nunca o e-mail em texto puro.
CREATE TABLE IF NOT EXISTS registration_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_registration_attempts_email_hash_created_at
    ON registration_attempts (email_hash, created_at);

ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE registration_attempts ENABLE ROW LEVEL SECURITY;
