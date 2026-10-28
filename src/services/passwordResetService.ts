import { createHash, createHmac, randomBytes } from "node:crypto";
import { getDatabasePool } from "../database/database.js";
import { getJwtSecret, hashPassword, validatePassword, ValidationError } from "./authService.js";
import { normalizeEmail, validateEmail } from "./identifierNormalization.js";
import { hasExceededHourlyLimit } from "./telegramRateLimiter.js";
import { emailService } from "./emailService.js";

export { ValidationError };

const TOKEN_TTL_MINUTES = 30;
const REQUEST_LIMIT_PER_EMAIL_PER_HOUR = 3;
const REQUEST_LIMIT_PER_IP_PER_HOUR = 10;
const CONFIRM_LIMIT_PER_IP_PER_HOUR = 20;
const MIN_RESPONSE_DELAY_MS = 800;
const ONE_HOUR_MS = 60 * 60 * 1000;

export const GENERIC_REQUEST_MESSAGE =
    "Se esse e-mail estiver cadastrado, enviamos um link para redefinir a senha.";
export const GENERIC_INVALID_TOKEN_MESSAGE = "Link inválido ou expirado.";
export const GENERIC_RATE_LIMIT_MESSAGE = "Muitas tentativas. Tente novamente mais tarde.";

export class PasswordResetConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PasswordResetConfigurationError";
    }
}

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Nunca deriva de Host/Origin/cabeçalhos da requisição (recebe só o que está no
 * ambiente), para que o link de redefinição não possa ser manipulado por quem envia a requisição.
 */
export function getAppBaseUrl(): string {
    const raw = process.env.APP_BASE_URL?.trim();
    if (!raw) {
        throw new PasswordResetConfigurationError("APP_BASE_URL não foi configurada.");
    }

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new PasswordResetConfigurationError("APP_BASE_URL não é uma URL válida.");
    }

    const isHttps = parsed.protocol === "https:";
    const isLocalHttp = parsed.protocol === "http:" && LOCALHOST_HOSTNAMES.has(parsed.hostname);
    if (!isHttps && !isLocalHttp) {
        throw new PasswordResetConfigurationError(
            "APP_BASE_URL deve usar https (http só é aceito para localhost)."
        );
    }

    return raw.replace(/\/+$/, "");
}

export function buildResetLink(token: string): string {
    return `${getAppBaseUrl()}/#redefinir=${token}`;
}

/** HMAC-SHA256 com JWT_SECRET: evita que um dump do banco exponha e-mails/IPs reais. */
export function hashIdentifier(value: string): string {
    return createHmac("sha256", getJwtSecret()).update(value).digest("hex");
}

/** SHA256 puro: o token já tem entropia suficiente (32 bytes aleatórios), não precisa de HMAC. */
function hashResetToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function generateResetToken(): string {
    return randomBytes(32).toString("base64url");
}

async function waitRemainingDelay(startedAt: number, minDelayMs: number = MIN_RESPONSE_DELAY_MS): Promise<void> {
    const remaining = minDelayMs - (Date.now() - startedAt);
    if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
    }
}

async function countRequestAttemptsByEmail(emailHash: string, since: Date): Promise<number> {
    const result = await getDatabasePool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM password_reset_attempts
         WHERE email_hash = $1 AND kind = 'request' AND created_at >= $2;`,
        [emailHash, since]
    );
    return Number(result.rows[0]?.count ?? 0);
}

async function countRequestAttemptsByIp(ipHash: string, since: Date): Promise<number> {
    const result = await getDatabasePool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM password_reset_attempts
         WHERE ip_hash = $1 AND kind = 'request' AND created_at >= $2;`,
        [ipHash, since]
    );
    return Number(result.rows[0]?.count ?? 0);
}

async function countConfirmAttemptsByIp(ipHash: string, since: Date): Promise<number> {
    const result = await getDatabasePool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM password_reset_attempts
         WHERE ip_hash = $1 AND kind = 'confirm' AND created_at >= $2;`,
        [ipHash, since]
    );
    return Number(result.rows[0]?.count ?? 0);
}

async function recordRequestAttempt(emailHash: string, ipHash: string): Promise<void> {
    await getDatabasePool().query(
        `INSERT INTO password_reset_attempts (email_hash, ip_hash, kind) VALUES ($1, $2, 'request');`,
        [emailHash, ipHash]
    );
}

async function recordConfirmAttempt(ipHash: string): Promise<void> {
    await getDatabasePool().query(
        `INSERT INTO password_reset_attempts (ip_hash, kind) VALUES ($1, 'confirm');`,
        [ipHash]
    );
}

/** Limpeza oportunista e barata: nunca atrasa a resposta ao usuário (dispara sem esperar). */
function cleanupOldRecordsInBackground(): void {
    const pool = getDatabasePool();
    const cutoff = new Date(Date.now() - 24 * ONE_HOUR_MS);

    void pool
        .query("DELETE FROM password_reset_tokens WHERE expires_at < $1;", [cutoff])
        .catch((error: unknown) => {
            console.error("Falha na limpeza de password_reset_tokens.", error instanceof Error ? error.message : error);
        });
    void pool
        .query("DELETE FROM password_reset_attempts WHERE created_at < $1;", [cutoff])
        .catch((error: unknown) => {
            console.error("Falha na limpeza de password_reset_attempts.", error instanceof Error ? error.message : error);
        });
}

async function findUserIdByEmail(email: string): Promise<number | undefined> {
    const result = await getDatabasePool().query<{ id: string }>(
        "SELECT id FROM users WHERE email = $1 AND password_hash IS NOT NULL;",
        [email]
    );
    const row = result.rows[0];
    return row ? Number(row.id) : undefined;
}

async function invalidateExistingTokens(userId: number): Promise<void> {
    await getDatabasePool().query(
        "UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL;",
        [userId]
    );
}

async function issueAndSendResetToken(userId: number, email: string): Promise<void> {
    await invalidateExistingTokens(userId);

    const token = generateResetToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000);

    await getDatabasePool().query(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3);",
        [userId, hashResetToken(token), expiresAt]
    );

    await emailService.sendPasswordResetEmail(email, buildResetLink(token));
}

export type PasswordResetRequestOutcome =
    | { status: "ok"; message: string }
    | { status: "rate-limited"; message: string };

/**
 * Sempre retorna a mesma mensagem de sucesso e um tempo de resposta equalizado, exista
 * ou não o e-mail, para não revelar quais contas existem.
 */
export async function requestPasswordReset(rawEmail: string, clientIp: string): Promise<PasswordResetRequestOutcome> {
    const email = normalizeEmail(rawEmail.trim());
    validateEmail(email);

    const startedAt = Date.now();
    try {
        const emailHash = hashIdentifier(email);
        const ipHash = hashIdentifier(clientIp);
        const since = new Date(Date.now() - ONE_HOUR_MS);

        const [emailAttempts, ipAttempts] = await Promise.all([
            countRequestAttemptsByEmail(emailHash, since),
            countRequestAttemptsByIp(ipHash, since)
        ]);

        if (
            hasExceededHourlyLimit(emailAttempts, REQUEST_LIMIT_PER_EMAIL_PER_HOUR) ||
            hasExceededHourlyLimit(ipAttempts, REQUEST_LIMIT_PER_IP_PER_HOUR)
        ) {
            return { status: "rate-limited", message: GENERIC_REQUEST_MESSAGE };
        }

        await recordRequestAttempt(emailHash, ipHash);

        const userId = await findUserIdByEmail(email);
        if (userId !== undefined) {
            await issueAndSendResetToken(userId, email);
        }

        cleanupOldRecordsInBackground();

        return { status: "ok", message: GENERIC_REQUEST_MESSAGE };
    } catch (error) {
        console.error(
            "Falha ao processar pedido de redefinição de senha.",
            error instanceof Error ? error.message : error
        );
        return { status: "ok", message: GENERIC_REQUEST_MESSAGE };
    } finally {
        await waitRemainingDelay(startedAt);
    }
}

export type PasswordResetConfirmOutcome = "ok" | "invalid" | "rate-limited";

/**
 * Valida a senha nova ANTES de consumir o token (uma senha fraca não desperdiça um
 * token ainda válido) mas DEPOIS de registrar a tentativa (para contar no limite por
 * IP mesmo quando a senha enviada é inválida).
 */
export async function confirmPasswordReset(
    rawToken: string,
    newPassword: string,
    clientIp: string
): Promise<PasswordResetConfirmOutcome> {
    const ipHash = hashIdentifier(clientIp);
    const since = new Date(Date.now() - ONE_HOUR_MS);

    const ipAttempts = await countConfirmAttemptsByIp(ipHash, since);
    if (hasExceededHourlyLimit(ipAttempts, CONFIRM_LIMIT_PER_IP_PER_HOUR)) {
        return "rate-limited";
    }

    await recordConfirmAttempt(ipHash);

    validatePassword(newPassword);

    const tokenHash = hashResetToken(rawToken.trim());
    const pool = getDatabasePool();
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const claimed = await client.query<{ user_id: string }>(
            `UPDATE password_reset_tokens
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
        const passwordHash = await hashPassword(newPassword);

        await client.query(
            "UPDATE users SET password_hash = $1, password_changed_at = CURRENT_TIMESTAMP WHERE id = $2;",
            [passwordHash, userId]
        );
        await client.query(
            "UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL;",
            [userId]
        );

        await client.query("COMMIT");
        return "ok";
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}
