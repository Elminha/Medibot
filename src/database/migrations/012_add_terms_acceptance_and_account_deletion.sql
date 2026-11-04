-- Aceite dos Termos de Uso / Política de Privacidade no cadastro (ver CURRENT_TERMS_VERSION
-- em authService.ts). Contas existentes ficam com as duas colunas NULL: não há como
-- provar retroativamente que aceitaram um texto que não existia quando se cadastraram.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS terms_version TEXT;

-- Limite de tentativas em DELETE /api/account (ver accountService.ts): protege a senha
-- da própria conta contra força bruta nesse endpoint. Por user_id (já autenticado), não
-- precisa de hash. ON DELETE CASCADE: se a exclusão da conta for concluída com sucesso,
-- a própria linha que registrou a última tentativa desaparece junto, sem deixar lixo.
CREATE TABLE IF NOT EXISTS account_deletion_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_attempts_user_id_created_at
    ON account_deletion_attempts (user_id, created_at);

ALTER TABLE account_deletion_attempts ENABLE ROW LEVEL SECURITY;
