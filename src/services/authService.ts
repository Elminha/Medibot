import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { getDatabasePool } from "../database/database.js";
import {
    normalizeEmail,
    normalizeLoginIdentifier,
    normalizePhone,
    validateEmail,
    ValidationError
} from "./identifierNormalization.js";

export { ValidationError };

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72;
const BCRYPT_ROUNDS = 12;
const TOKEN_EXPIRATION = "7d";

export interface AuthUser {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    timezone: string;
    telegramLinked: boolean;
}

export interface RegisterInput {
    name: string;
    password: string;
    email?: string;
    phone?: string;
    timezone?: string;
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
}

export class AccountAlreadyExistsError extends Error {
    constructor() {
        super("Já existe uma conta com esses dados.");
        this.name = "AccountAlreadyExistsError";
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
        telegramLinked: row.telegram_chat_id !== null
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
        `SELECT id, name, email, phone, timezone, password_hash, telegram_chat_id, password_changed_at
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

export async function registerUser(input: RegisterInput): Promise<AuthResult> {
    getJwtSecret();

    const name = input.name.trim();
    if (!name) {
        throw new ValidationError("O nome é obrigatório.");
    }
    validatePassword(input.password);

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
    const existing = await pool.query(
        "SELECT 1 FROM users WHERE email = $1 OR phone = $2 LIMIT 1;",
        [email, phone ?? null]
    );
    if (existing.rowCount && existing.rowCount > 0) {
        throw new AccountAlreadyExistsError();
    }

    const passwordHash = await hashPassword(input.password);

    try {
        const result = await pool.query<AuthUserRow>(
            `INSERT INTO users (name, email, password_hash, phone, timezone)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, name, email, phone, timezone, password_hash, telegram_chat_id;`,
            [name, email, passwordHash, phone ?? null, timezone]
        );
        const user = toAuthUser(result.rows[0]);
        return { user, token: createToken(user.id) };
    } catch (error: unknown) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
            throw new AccountAlreadyExistsError();
        }
        throw error;
    }
}

export async function loginUser(input: LoginInput): Promise<AuthResult> {
    getJwtSecret();

    const identifier = normalizeLoginIdentifier(input.identifier);

    if (!input.password) {
        throw new InvalidCredentialsError();
    }

    const result = await getDatabasePool().query<AuthUserRow>(
        `SELECT id, name, email, phone, timezone, password_hash, telegram_chat_id
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
