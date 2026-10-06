import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { getDatabasePool } from "../database/database.js";

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72;
const BCRYPT_ROUNDS = 12;
const TOKEN_EXPIRATION = "7d";

export interface AuthUser {
    id: number;
    name: string;
    email: string;
    phone: string | null;
    timezone: string;
}

export interface RegisterInput {
    name: string;
    email: string;
    password: string;
    phone?: string;
    timezone?: string;
}

export interface LoginInput {
    email: string;
    password: string;
}

export interface AuthResult {
    user: AuthUser;
    token: string;
}

interface AuthUserRow {
    id: string;
    name: string;
    email: string;
    phone: string;
    timezone: string;
    password_hash: string;
}

export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
    }
}

export class EmailAlreadyRegisteredError extends Error {
    constructor() {
        super("Já existe uma conta cadastrada com este e-mail.");
        this.name = "EmailAlreadyRegisteredError";
    }
}

export class InvalidCredentialsError extends Error {
    constructor() {
        super("E-mail ou senha inválidos.");
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

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function validateEmail(email: string): void {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ValidationError("Informe um e-mail válido.");
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
        phone: row.phone.startsWith("AUTH-") ? null : row.phone,
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
    const email = normalizeEmail(input.email);
    const phone = input.phone?.trim();
    const timezone = input.timezone?.trim() || "America/Sao_Paulo";

    if (!name) {
        throw new ValidationError("O nome é obrigatório.");
    }
    validateEmail(email);
    validatePassword(input.password);
    if (input.phone !== undefined && !phone) {
        throw new ValidationError("O telefone, quando informado, não pode estar vazio.");
    }

    const pool = getDatabasePool();
    const existing = await pool.query("SELECT 1 FROM users WHERE email = $1;", [email]);
    if (existing.rowCount && existing.rowCount > 0) {
        throw new EmailAlreadyRegisteredError();
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    try {
        const result = await pool.query<AuthUserRow>(
            `INSERT INTO users (name, email, password_hash, phone, timezone)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, name, email, phone, timezone, password_hash;`,
            [name, email, passwordHash, phone || `AUTH-${randomUUID()}`, timezone]
        );
        const user = toAuthUser(result.rows[0]);
        return { user, token: createToken(user.id) };
    } catch (error: unknown) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
            throw new EmailAlreadyRegisteredError();
        }
        throw error;
    }
}

export async function loginUser(input: LoginInput): Promise<AuthResult> {
    getJwtSecret();

    const email = normalizeEmail(input.email);
    validateEmail(email);

    if (!input.password) {
        throw new InvalidCredentialsError();
    }

    const result = await getDatabasePool().query<AuthUserRow>(
        `SELECT id, name, email, phone, timezone, password_hash
         FROM users
         WHERE email = $1 AND password_hash IS NOT NULL;`,
        [email]
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
         WHERE id = $1 AND email IS NOT NULL AND password_hash IS NOT NULL;`,
        [userId]
    );

    if (!result.rows[0]) {
        throw new AuthUserNotFoundError();
    }

    return toAuthUser(result.rows[0]);
}
