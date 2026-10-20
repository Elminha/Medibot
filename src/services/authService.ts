import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { getDatabasePool } from "../database/database.js";
import {
    assertHasEmailOrPhone,
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

export class AuthUserNotFoundError extends Error {
    constructor() {
        super("Usuário autenticado não encontrado.");
        this.name = "AuthUserNotFoundError";
    }
}

export class AuthConfigurationError extends Error {
    constructor() {
        super("JWT_SECRET não foi configurado.");
        this.name = "AuthConfigurationError";
    }
}

function validatePassword(password: string): void {
    if (password.length < PASSWORD_MIN_LENGTH) {
        throw new ValidationError(`A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`);
    }

    if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
        throw new ValidationError("A senha deve ter no máximo 72 bytes.");
    }
}

function getJwtSecret(): string {
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
        timezone: row.timezone
    };
}

function createToken(userId: number): string {
    return jwt.sign({ sub: String(userId) }, getJwtSecret(), { expiresIn: TOKEN_EXPIRATION });
}

function parseTokenSubject(payload: jwt.JwtPayload | string): number | undefined {
    if (typeof payload === "string" || typeof payload.sub !== "string") {
        return undefined;
    }

    const userId = Number(payload.sub);
    return Number.isSafeInteger(userId) && userId > 0 ? userId : undefined;
}

export function getAuthenticatedUserId(token: string): number | undefined {
    const secret = getJwtSecret();

    try {
        return parseTokenSubject(jwt.verify(token, secret));
    } catch {
        return undefined;
    }
}

export async function registerUser(input: RegisterInput): Promise<AuthResult> {
    getJwtSecret();

    const name = input.name.trim();
    if (!name) {
        throw new ValidationError("O nome é obrigatório.");
    }
    validatePassword(input.password);

    const rawEmail = input.email?.trim();
    const email = rawEmail ? normalizeEmail(rawEmail) : undefined;
    if (email) {
        validateEmail(email);
    }

    // Telefone ainda não é verificado (sem envio de SMS/código de confirmação): serve
    // apenas como identificador alternativo de login/cadastro, nunca para vincular
    // automaticamente contas por coincidência de número.
    const rawPhone = input.phone?.trim();
    const phone = rawPhone ? normalizePhone(rawPhone) : undefined;

    assertHasEmailOrPhone(email, phone);

    const timezone = input.timezone?.trim() || "America/Sao_Paulo";

    const pool = getDatabasePool();
    const existing = await pool.query(
        "SELECT 1 FROM users WHERE email = $1 OR phone = $2 LIMIT 1;",
        [email ?? null, phone ?? null]
    );
    if (existing.rowCount && existing.rowCount > 0) {
        throw new AccountAlreadyExistsError();
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    try {
        const result = await pool.query<AuthUserRow>(
            `INSERT INTO users (name, email, password_hash, phone, timezone)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, name, email, phone, timezone, password_hash;`,
            [name, email ?? null, passwordHash, phone ?? null, timezone]
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
        `SELECT id, name, email, phone, timezone, password_hash
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

export async function getAuthUserById(userId: number): Promise<AuthUser> {
    const result = await getDatabasePool().query<AuthUserRow>(
        `SELECT id, name, email, phone, timezone, password_hash
         FROM users
         WHERE id = $1 AND password_hash IS NOT NULL;`,
        [userId]
    );

    if (!result.rows[0]) {
        throw new AuthUserNotFoundError();
    }

    return toAuthUser(result.rows[0]);
}
