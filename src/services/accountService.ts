import bcrypt from "bcrypt";
import { getDatabasePool } from "../database/database.js";
import { hasExceededHourlyLimit } from "./telegramRateLimiter.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const DELETION_ATTEMPT_LIMIT_PER_HOUR = 5;

export class IncorrectPasswordError extends Error {
    constructor() {
        super("Senha incorreta.");
        this.name = "IncorrectPasswordError";
    }
}

export class AccountDeletionRateLimitedError extends Error {
    constructor() {
        super("Muitas tentativas. Tente novamente mais tarde.");
        this.name = "AccountDeletionRateLimitedError";
    }
}

async function countDeletionAttempts(userId: number, since: Date): Promise<number> {
    const result = await getDatabasePool().query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM account_deletion_attempts WHERE user_id = $1 AND created_at >= $2;",
        [userId, since]
    );
    return Number(result.rows[0]?.count ?? 0);
}

async function recordDeletionAttempt(userId: number): Promise<void> {
    await getDatabasePool().query("INSERT INTO account_deletion_attempts (user_id) VALUES ($1);", [userId]);
}

/**
 * Apaga a própria conta e todos os dados associados, numa única transação. A grande
 * maioria das tabelas já tem ON DELETE CASCADE a partir de users (medicamentos,
 * lembretes com seus horários/dias/canais/entregas, conversas, vínculo e códigos do
 * Telegram, tokens e tentativas de reset de senha e de verificação de e-mail, as
 * próprias tentativas de exclusão) — basta apagar a linha de users por último.
 * feedback.user_id é ON DELETE SET NULL de propósito (mantém o feedback para melhoria
 * do produto mesmo depois que outras contas são excluídas), mas aqui apagamos
 * explicitamente também o feedback da conta que está sendo excluída, para a exclusão
 * ser completa como descrito ao usuário na tela de confirmação.
 */
export async function deleteOwnAccount(userId: number, password: string): Promise<void> {
    const pool = getDatabasePool();

    const since = new Date(Date.now() - ONE_HOUR_MS);
    const attempts = await countDeletionAttempts(userId, since);
    if (hasExceededHourlyLimit(attempts, DELETION_ATTEMPT_LIMIT_PER_HOUR)) {
        throw new AccountDeletionRateLimitedError();
    }
    await recordDeletionAttempt(userId);

    const result = await pool.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id = $1;",
        [userId]
    );
    const passwordHash = result.rows[0]?.password_hash;
    if (!passwordHash || !(await bcrypt.compare(password, passwordHash))) {
        throw new IncorrectPasswordError();
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("DELETE FROM feedback WHERE user_id = $1;", [userId]);
        await client.query("DELETE FROM users WHERE id = $1;", [userId]);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}
