import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { createHmac } from "node:crypto";
import { getDatabasePool } from "../database/database.js";
import {
    normalizeEmail,
    normalizeLoginIdentifier,
    normalizePhone,
    validateEmail,
    ValidationError
} from "./identifierNormalization.js";
import { hasExceededHourlyLimit } from "./telegramRateLimiter.js";

export { ValidationError };

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72;
const BCRYPT_ROUNDS = 12;
const TOKEN_EXPIRATION = "7d";
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
// Limite de tomada de cadastro por e-mail-alvo (não por quem está tentando cadastrar):
// evita que alguém fique tentando se cadastrar repetidamente com o e-mail de outra
// pessoa só para invalidar o token de verificação dela.
const TAKEOVER_LIMIT_PER_EMAIL_PER_HOUR = 3;
const TAKEOVER_LIMIT_PER_EMAIL_PER_DAY = 10;
// Identifica qual versão dos Termos de Uso/Política de Privacidade foi aceita no
// cadastro (users.terms_version); atualizar junto com a data no topo das páginas
// /termos e /privacidade quando o texto mudar.
export const CURRENT_TERMS_VERSION = "2026-11";

export interface AuthUser {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    timezone: string;
    telegramLinked: boolean;
    // Contas sem e-mail (legado, só telefone) são tratadas como verificadas: não há
    // e-mail para confirmar. Ver requireVerifiedEmail em authMiddleware.ts.
    emailVerified: boolean;
}

export interface RegisterInput {
    name: string;
    password: string;
    email?: string;
    phone?: string;
    timezone?: string;
    termsAccepted?: boolean;
}

export interface LoginInput {
    identifier: string;
    password: string;
}

export interface AuthResult {
    user: AuthUser;
    token: string;
}

interface AuthUserRow {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    timezone: string;
    password_hash: string;
    telegram_chat_id: string | null;
    email_verified_at: Date | null;
}

export class AccountAlreadyExistsError extends Error {
    constructor() {
        super("Já existe uma conta com esses dados.");
        this.name = "AccountAlreadyExistsError";
    }
}

export class TooManyRegistrationAttemptsError extends Error {
    constructor() {
        super("Muitas tentativas. Tente novamente mais tarde.");
        this.name = "TooManyRegistrationAttemptsError";
    }
}

export class InvalidCredentialsError extends Error {
    constructor() {
        super("Credenciais inválidas.");
        this.name = "InvalidCredentialsError";
    }
}

export class AuthConfigurationError extends Error {
    constructor() {
        super("JWT_SECRET não foi configurado.");
        this.name = "AuthConfigurationError";
    }
}

/** Mesmas regras usadas no cadastro; reaproveitada pela redefinição de senha. */
export function validatePassword(password: string): void {
    if (password.length < PASSWORD_MIN_LENGTH) {
        throw new ValidationError(`A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`);
    }

    if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
        throw new ValidationError("A senha deve ter no máximo 72 bytes.");
    }
}

/** Mesmo hash usado no cadastro; reaproveitado pela redefinição de senha. */
export async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function getJwtSecret(): string {
    const secret = process.env.JWT_SECRET?.trim();

    if (!secret) {
        throw new AuthConfigurationError();
    }

    return secret;
}

function toAuthUser(row: AuthUserRow): AuthUser {
    return {
        id: Number(row.id),
        name: row.name,
        email: row.email,
        // Contas antigas (só e-mail, de antes do telefone ser opcional) usavam um
        // placeholder "AUTH-<uuid>" no telefone para satisfazer a coluna NOT NULL/UNIQUE
        // que existia então. Isso não é um telefone real e nunca deve ser exposto.
        phone: row.phone && row.phone.startsWith("AUTH-") ? null : row.phone,
        timezone: row.timezone,
        telegramLinked: row.telegram_chat_id !== null,
        emailVerified: row.email === null || row.email_verified_at !== null
    };
}

function createToken(userId: number): string {
    return jwt.sign({ sub: String(userId) }, getJwtSecret(), { expiresIn: TOKEN_EXPIRATION });
}

interface TokenClaims {
    userId: number;
    issuedAtMs: number;
}

function parseTokenClaims(payload: jwt.JwtPayload | string): TokenClaims | undefined {
    if (typeof payload === "string" || typeof payload.sub !== "string" || typeof payload.iat !== "number") {
        return undefined;
    }

    const userId = Number(payload.sub);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return undefined;
    }

    return { userId, issuedAtMs: payload.iat * 1000 };
}

function verifyAuthToken(token: string): TokenClaims | undefined {
    const secret = getJwtSecret();

    try {
        return parseTokenClaims(jwt.verify(token, secret));
    } catch {
        return undefined;
    }
}

/**
 * Um token emitido (`iat`) antes da troca de senha deixa de ser válido. Compara em
 * segundos (granularidade do `iat`) para não invalidar, por arredondamento, o próprio
 * login feito depois da troca (não há login automático após redefinir a senha, então
 * um token legítimo sempre é emitido no mesmo segundo ou depois do `password_changed_at`).
 */
export function isTokenRevokedByPasswordChange(issuedAtMs: number, passwordChangedAt: Date | null): boolean {
    if (!passwordChangedAt) {
        return false;
    }

    const changedAtFlooredToSecondMs = Math.floor(passwordChangedAt.getTime() / 1000) * 1000;
    return issuedAtMs < changedAtFlooredToSecondMs;
}

interface AuthenticatedUserRow extends AuthUserRow {
    password_changed_at: Date | null;
}

/** Verifica o JWT e busca o usuário atual; usada por requireAuthentication (única consulta por requisição). */
export async function getAuthenticatedUser(token: string): Promise<AuthUser | undefined> {
    const claims = verifyAuthToken(token);
    if (!claims) {
        return undefined;
    }

    const result = await getDatabasePool().query<AuthenticatedUserRow>(
        `SELECT id, name, email, phone, timezone, password_hash, telegram_chat_id, password_changed_at, email_verified_at
         FROM users
         WHERE id = $1 AND password_hash IS NOT NULL;`,
        [claims.userId]
    );
    const row = result.rows[0];
    if (!row) {
        return undefined;
    }

    if (isTokenRevokedByPasswordChange(claims.issuedAtMs, row.password_changed_at)) {
        return undefined;
    }

    return toAuthUser(row);
}

interface Queryable {
    query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * Conta sem nenhum dado próprio (conversas, lembretes, feedback ou vínculo do
 * Telegram): critério usado para decidir se uma conta nunca verificada pode ser
 * substituída por um novo cadastro no mesmo e-mail (ver registerUser). Roda na mesma
 * `client`/transação que travou a linha do usuário, para ler um estado consistente.
 */
async function hasAnyUserData(db: Queryable, userId: number): Promise<boolean> {
    const result = await db.query<{ has_data: boolean }>(
        `SELECT EXISTS (
            SELECT 1 FROM queries WHERE user_id = $1
            UNION ALL
            SELECT 1 FROM reminders r INNER JOIN medications m ON m.id = r.medication_id WHERE m.user_id = $1
            UNION ALL
            SELECT 1 FROM feedback WHERE user_id = $1
            UNION ALL
            SELECT 1 FROM users WHERE id = $1 AND telegram_chat_id IS NOT NULL
        ) AS has_data;`,
        [userId]
    );
    return result.rows[0]?.has_data === true;
}

/**
 * HMAC-SHA256 com JWT_SECRET: mesma técnica de hashIdentifier em
 * passwordResetService.ts (duplicada aqui para não criar um import circular entre os
 * dois módulos — passwordResetService já importa de authService).
 */
function hashEmailForRateLimit(email: string): string {
    return createHmac("sha256", getJwtSecret()).update(email).digest("hex");
}

async function countRegistrationAttempts(emailHash: string, since: Date): Promise<number> {
    const result = await getDatabasePool().query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM registration_attempts WHERE email_hash = $1 AND created_at >= $2;",
        [emailHash, since]
    );
    return Number(result.rows[0]?.count ?? 0);
}

async function recordRegistrationAttempt(emailHash: string): Promise<void> {
    await getDatabasePool().query("INSERT INTO registration_attempts (email_hash) VALUES ($1);", [emailHash]);
}

export async function registerUser(input: RegisterInput): Promise<AuthResult> {
    getJwtSecret();

    const name = input.name.trim();
    if (!name) {
        throw new ValidationError("O nome é obrigatório.");
    }
    validatePassword(input.password);

    if (input.termsAccepted !== true) {
        throw new ValidationError("Você precisa aceitar os Termos de Uso e a Política de Privacidade.");
    }

    const rawEmail = input.email?.trim();
    if (!rawEmail) {
        throw new ValidationError("O e-mail é obrigatório.");
    }
    const email = normalizeEmail(rawEmail);
    validateEmail(email);

    // Telefone ainda não é verificado (sem envio de SMS/código de confirmação): serve
    // apenas como identificador alternativo de login/cadastro, nunca para vincular
    // automaticamente contas por coincidência de número.
    const rawPhone = input.phone?.trim();
    const phone = rawPhone ? normalizePhone(rawPhone) : undefined;

    const timezone = input.timezone?.trim() || "America/Sao_Paulo";

    const pool = getDatabasePool();

    if (phone) {
        const phoneMatch = await pool.query("SELECT 1 FROM users WHERE phone = $1 LIMIT 1;", [phone]);
        if (phoneMatch.rowCount && phoneMatch.rowCount > 0) {
            throw new AccountAlreadyExistsError();
        }
    }

    // bcrypt.hash é CPU-bound e não depende do banco: calculado antes de abrir a
    // transação, para a trava da linha (FOR UPDATE) ficar presa pelo menor tempo possível.
    const passwordHash = await hashPassword(input.password);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Trava a linha do e-mail (se existir) antes de decidir qualquer coisa: fecha a
        // corrida com confirmEmailVerification, que trava a MESMA linha antes de marcar
        // email_verified_at (mesma ordem de lock nos dois lados, ver emailVerificationService.ts).
        const emailMatch = await client.query<{ id: string; email_verified_at: Date | null }>(
            "SELECT id, email_verified_at FROM users WHERE email = $1 LIMIT 1 FOR UPDATE;",
            [email]
        );
        const existingEmailRow = emailMatch.rows[0];

        if (existingEmailRow) {
            // Limite por e-mail-alvo (3/hora, 10/dia): fora da transação/trava de
            // propósito, para continuar contando mesmo quando a tentativa é rejeitada
            // (ninguém pode ficar testando repetidamente se um e-mail está verificado).
            const emailHash = hashEmailForRateLimit(email);
            const now = new Date();
            const [hourlyAttempts, dailyAttempts] = await Promise.all([
                countRegistrationAttempts(emailHash, new Date(now.getTime() - ONE_HOUR_MS)),
                countRegistrationAttempts(emailHash, new Date(now.getTime() - ONE_DAY_MS))
            ]);
            if (
                hasExceededHourlyLimit(hourlyAttempts, TAKEOVER_LIMIT_PER_EMAIL_PER_HOUR) ||
                hasExceededHourlyLimit(dailyAttempts, TAKEOVER_LIMIT_PER_EMAIL_PER_DAY)
            ) {
                throw new TooManyRegistrationAttemptsError();
            }
            await recordRegistrationAttempt(emailHash);

            const existingUserId = Number(existingEmailRow.id);
            const isVerified = existingEmailRow.email_verified_at !== null;

            if (isVerified || (await hasAnyUserData(client, existingUserId))) {
                throw new AccountAlreadyExistsError();
            }

            // Conta antiga, nunca verificada e sem nenhum dado: substituída pelo novo
            // cadastro (nova senha, novo token de verificação). O DELETE já invalida
            // qualquer token de verificação pendente dessa conta via ON DELETE CASCADE
            // em email_verification_tokens.user_id. Contas verificadas ou com dados
            // nunca são substituídas (caso acima).
            await client.query("DELETE FROM users WHERE id = $1;", [existingUserId]);
        }

        const result = await client.query<AuthUserRow>(
            `INSERT INTO users (name, email, password_hash, phone, timezone, terms_accepted_at, terms_version)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6)
             RETURNING id, name, email, phone, timezone, password_hash, telegram_chat_id, email_verified_at;`,
            [name, email, passwordHash, phone ?? null, timezone, CURRENT_TERMS_VERSION]
        );

        await client.query("COMMIT");
        const user = toAuthUser(result.rows[0]);
        return { user, token: createToken(user.id) };
    } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof AccountAlreadyExistsError || error instanceof TooManyRegistrationAttemptsError) {
            throw error;
        }
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
            throw new AccountAlreadyExistsError();
        }
        throw error;
    } finally {
        client.release();
    }
}

export async function loginUser(input: LoginInput): Promise<AuthResult> {
    getJwtSecret();

    const identifier = normalizeLoginIdentifier(input.identifier);

    if (!input.password) {
        throw new InvalidCredentialsError();
    }

    const result = await getDatabasePool().query<AuthUserRow>(
        `SELECT id, name, email, phone, timezone, password_hash, telegram_chat_id, email_verified_at
         FROM users
         WHERE (email = $1 OR phone = $1) AND password_hash IS NOT NULL;`,
        [identifier.value]
    );
    const row = result.rows[0];

    if (!row || !(await bcrypt.compare(input.password, row.password_hash))) {
        throw new InvalidCredentialsError();
    }

    const user = toAuthUser(row);
    return { user, token: createToken(user.id) };
}
