import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { getDatabasePool } from "../database/database.js";

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72;
const BCRYPT_ROUNDS = 12;
const TOKEN_EXPIRATION = "7d";

export interface AuthUser { id: number; name: string; email: string | null; phone: string; timezone: string; }
export interface RegisterInput { name: string; password: string; phone: string; email?: string; timezone?: string; }
export interface LoginInput { phone: string; password: string; }
export interface AuthResult { user: AuthUser; token: string; }
interface AuthUserRow { id: string; name: string; email: string | null; phone: string; timezone: string; password_hash: string; }

export class ValidationError extends Error { constructor(message: string) { super(message); this.name = "ValidationError"; } }
export class PhoneAlreadyRegisteredError extends Error { constructor() { super("Já existe uma conta cadastrada com este telefone."); this.name = "PhoneAlreadyRegisteredError"; } }
export class InvalidCredentialsError extends Error { constructor() { super("Telefone ou senha inválidos."); this.name = "InvalidCredentialsError"; } }
export class AuthUserNotFoundError extends Error { constructor() { super("Usuário autenticado não encontrado."); this.name = "AuthUserNotFoundError"; } }
export class AuthConfigurationError extends Error { constructor() { super("JWT_SECRET não foi configurado."); this.name = "AuthConfigurationError"; } }

function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }
function validateEmail(email: string): void {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("Informe um e-mail válido.");
}

/** Accepts formatting characters but requires an explicit international prefix. */
export function normalizePhone(phone: string): string {
    const normalized = phone.trim().replace(/[\s().-]/g, "");
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
        throw new ValidationError("Informe o telefone no formato internacional, por exemplo +5511999999999.");
    }
    return normalized;
}

function validatePassword(password: string): void {
    if (password.length < PASSWORD_MIN_LENGTH) throw new ValidationError(`A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`);
    if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) throw new ValidationError("A senha deve ter no máximo 72 bytes.");
}
function getJwtSecret(): string {
    const secret = process.env.JWT_SECRET?.trim();
    if (!secret) throw new AuthConfigurationError();
    return secret;
}
function toAuthUser(row: AuthUserRow): AuthUser { return { id: Number(row.id), name: row.name, email: row.email, phone: row.phone, timezone: row.timezone }; }
function createToken(userId: number): string { return jwt.sign({ sub: String(userId) }, getJwtSecret(), { expiresIn: TOKEN_EXPIRATION }); }
function parseTokenSubject(payload: jwt.JwtPayload | string): number | undefined {
    if (typeof payload === "string" || typeof payload.sub !== "string") return undefined;
    const userId = Number(payload.sub);
    return Number.isSafeInteger(userId) && userId > 0 ? userId : undefined;
}

export function getAuthenticatedUserId(token: string): number | undefined {
    try { return parseTokenSubject(jwt.verify(token, getJwtSecret())); } catch { return undefined; }
}

export async function registerUser(input: RegisterInput): Promise<AuthResult> {
    getJwtSecret();
    const name = input.name.trim();
    const phone = normalizePhone(input.phone);
    const email = input.email?.trim() ? normalizeEmail(input.email) : undefined;
    const timezone = input.timezone?.trim() || "America/Sao_Paulo";
    if (!name) throw new ValidationError("O nome é obrigatório.");
    if (email) validateEmail(email);
    validatePassword(input.password);

    const pool = getDatabasePool();
    const existing = await pool.query("SELECT 1 FROM users WHERE phone_e164 = $1;", [phone]);
    if (existing.rowCount) throw new PhoneAlreadyRegisteredError();
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    try {
        const result = await pool.query<AuthUserRow>(
            `INSERT INTO users (name, email, password_hash, phone, phone_e164, timezone)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, name, email, phone, timezone, password_hash;`,
            [name, email ?? null, passwordHash, phone, phone, timezone]
        );
        const user = toAuthUser(result.rows[0]);
        return { user, token: createToken(user.id) };
    } catch (error: unknown) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new PhoneAlreadyRegisteredError();
        throw error;
    }
}

export async function loginUser(input: LoginInput): Promise<AuthResult> {
    getJwtSecret();
    const phone = normalizePhone(input.phone);
    if (!input.password) throw new InvalidCredentialsError();
    const result = await getDatabasePool().query<AuthUserRow>(
        `SELECT id, name, email, phone, timezone, password_hash FROM users
         WHERE phone_e164 = $1 AND password_hash IS NOT NULL;`, [phone]
    );
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(input.password, row.password_hash))) throw new InvalidCredentialsError();
    const user = toAuthUser(row);
    return { user, token: createToken(user.id) };
}

export async function getAuthUserById(userId: number): Promise<AuthUser> {
    const result = await getDatabasePool().query<AuthUserRow>(
        `SELECT id, name, email, phone, timezone, password_hash FROM users
         WHERE id = $1 AND phone_e164 IS NOT NULL AND password_hash IS NOT NULL;`, [userId]
    );
    if (!result.rows[0]) throw new AuthUserNotFoundError();
    return toAuthUser(result.rows[0]);
}
