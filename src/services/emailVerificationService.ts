import { createHash, randomBytes } from "node:crypto";
import { getDatabasePool } from "../database/database.js";
import { getAppBaseUrl } from "./passwordResetService.js";
import { hasExceededHourlyLimit } from "./telegramRateLimiter.js";
import { emailService } from "./emailService.js";

const TOKEN_TTL_HOURS = 24;
const RESEND_LIMIT_PER_HOUR = 3;
const RESEND_LIMIT_PER_DAY = 10;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export const GENERIC_RESEND_RATE_LIMIT_MESSAGE = "Muitas tentativas. Tente novamente mais tarde.";

/** Só o texto exato "true" liga o bloqueio; ausente ou qualquer outro valor desliga (mesmo padrão de PASSWORD_RESET_ENABLED). */
export function isEmailVerificationRequired(): boolean {
    return process.env.EMAIL_VERIFICATION_REQUIRED === "true";
}

export function buildVerificationLink(token: string): string {
    return `${getAppBaseUrl()}/#verificar-email=${token}`;
}

/** SHA256 puro: o token já tem entropia suficiente (32 bytes aleatórios), não precisa de HMAC. */
function hashVerificationToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function generateVerificationToken(): string {
    return randomBytes(32).toString("base64url");
}

async function invalidateExistingVerificationTokens(userId: number): Promise<void> {
    await getDatabasePool().query(
        "UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL;",
        [userId]
    );
}

/** Gera e envia um novo token, invalidando os anteriores antes; usada no cadastro e no reenvio. */
export async function issueAndSendVerificationToken(userId: number, email: string): Promise<void> {
    await invalidateExistingVerificationTokens(userId);

    const token = generateVerificationToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * ONE_HOUR_MS);

    await getDatabasePool().query(
        "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3);",
        [userId, hashVerificationToken(token), expiresAt]
    );

    await emailService.sendEmailVerificationEmail(email, buildVerificationLink(token));
}

export type EmailVerificationConfirmOutcome = "ok" | "invalid";

/**
 * Consome o token (uso único) e marca o e-mail como verificado; "invalid" cobre
 * expirado, já usado, inexistente, ou a conta ter sido apagada entre o claim do token
 * e aqui (tomada de cadastro concorrente, ver registerUser em authService.ts).
 *
 * Trava a linha do usuário (FOR UPDATE) antes de marcar como verificado, na mesma
 * ordem de lock que registerUser usa para decidir uma tomada de conta: as duas
 * operações nunca correm por cima uma da outra na mesma conta.
 */
export async function confirmEmailVerification(rawToken: string): Promise<EmailVerificationConfirmOutcome> {
    const tokenHash = hashVerificationToken(rawToken.trim());
    const pool = getDatabasePool();
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const claimed = await client.query<{ user_id: string }>(
            `UPDATE email_verification_tokens
             SET used_at = CURRENT_TIMESTAMP
             WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
             RETURNING user_id;`,
            [tokenHash]
        );
        const row = claimed.rows[0];
        if (!row) {
            await client.query("ROLLBACK");
            return "invalid";
        }

        const userId = Number(row.user_id);

        const userLock = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE;", [userId]);
        if (!userLock.rows[0]) {
            await client.query("ROLLBACK");
            return "invalid";
        }

        await client.query(
            "UPDATE users SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP) WHERE id = $1;",
            [userId]
        );
        await client.query(
            "UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL;",
            [userId]
        );

        await client.query("COMMIT");
        return "ok";
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

/** Conta sem e-mail é tratada como verificada (nada para confirmar); usada pelo bot do Telegram. */
export async function isEmailVerified(userId: number): Promise<boolean> {
    const result = await getDatabasePool().query<{ email: string | null; email_verified_at: Date | null }>(
        "SELECT email, email_verified_at FROM users WHERE id = $1;",
        [userId]
    );
    const row = result.rows[0];
    if (!row) {
        return true;
    }
    return row.email === null || row.email_verified_at !== null;
}

export type ResendVerificationOutcome = "ok" | "already-verified" | "no-email" | "rate-limited";

async function countAttemptsSince(userId: number, since: Date): Promise<number> {
    const result = await getDatabasePool().query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM email_verification_attempts WHERE user_id = $1 AND created_at >= $2;",
        [userId, since]
    );
    return Number(result.rows[0]?.count ?? 0);
}

async function recordResendAttempt(userId: number): Promise<void> {
    await getDatabasePool().query(
        "INSERT INTO email_verification_attempts (user_id) VALUES ($1);",
        [userId]
    );
}

/** Reenvio autenticado: 3/hora e 10/dia por usuário, invalidando o token anterior ao gerar um novo. */
export async function resendVerificationEmail(userId: number): Promise<ResendVerificationOutcome> {
    const result = await getDatabasePool().query<{ email: string | null; email_verified_at: Date | null }>(
        "SELECT email, email_verified_at FROM users WHERE id = $1;",
        [userId]
    );
    const row = result.rows[0];
    if (!row || !row.email) {
        return "no-email";
    }
    if (row.email_verified_at !== null) {
        return "already-verified";
    }

    const now = new Date();
    const [hourlyCount, dailyCount] = await Promise.all([
        countAttemptsSince(userId, new Date(now.getTime() - ONE_HOUR_MS)),
        countAttemptsSince(userId, new Date(now.getTime() - ONE_DAY_MS))
    ]);

    if (
        hasExceededHourlyLimit(hourlyCount, RESEND_LIMIT_PER_HOUR) ||
        hasExceededHourlyLimit(dailyCount, RESEND_LIMIT_PER_DAY)
    ) {
        return "rate-limited";
    }

    await recordResendAttempt(userId);
    await issueAndSendVerificationToken(userId, row.email);

    return "ok";
}
