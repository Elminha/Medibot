import { createHash, randomInt } from "node:crypto";
import { getDatabasePool } from "../database/database.js";

export const LINK_CODE_LENGTH = 9;
export const LINK_CODE_TTL_MINUTES = 10;

// Sem caracteres ambíguos (0/O, 1/I/L não entram).
const LINK_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export class TelegramConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TelegramConfigurationError";
    }
}

export type LinkCodeOutcome =
    | { status: "linked"; userId: number }
    | { status: "invalid" }
    | { status: "chat-already-linked" }
    | { status: "user-already-linked" };

/** Gera um código aleatório curto usando um alfabeto sem caracteres ambíguos. */
export function generateLinkCode(length: number = LINK_CODE_LENGTH): string {
    let code = "";
    for (let index = 0; index < length; index += 1) {
        code += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
    }
    return code;
}

/** Nunca armazenamos o código em texto puro, apenas este hash. */
export function hashLinkCode(code: string): string {
    return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export function isLinkCodeExpired(expiresAt: Date, now: Date = new Date()): boolean {
    return expiresAt.getTime() <= now.getTime();
}

export function isLinkCodeUsed(usedAt: Date | null): boolean {
    return usedAt !== null;
}

export function getTelegramBotUsername(): string {
    const username = process.env.TELEGRAM_BOT_USERNAME?.trim();
    if (!username) {
        throw new TelegramConfigurationError("TELEGRAM_BOT_USERNAME não foi configurado.");
    }
    return username.replace(/^@/, "");
}

export function buildTelegramDeepLink(code: string): string {
    return `https://t.me/${getTelegramBotUsername()}?start=${code}`;
}

export interface LinkCodeResult {
    code: string;
    expiresAt: Date;
}

const MAX_GENERATION_ATTEMPTS = 3;

/** Gera e persiste um novo código de vínculo, invalidando os anteriores do usuário. */
export async function createLinkCode(userId: number): Promise<LinkCodeResult> {
    const pool = getDatabasePool();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);

    await pool.query(
        "UPDATE telegram_link_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL;",
        [userId]
    );

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
        const code = generateLinkCode();
        const codeHash = hashLinkCode(code);

        try {
            await pool.query(
                `INSERT INTO telegram_link_codes (user_id, code_hash, expires_at)
                 VALUES ($1, $2, $3);`,
                [userId, codeHash, expiresAt]
            );
            return { code, expiresAt };
        } catch (error: unknown) {
            const isUniqueViolation = typeof error === "object" && error !== null
                && "code" in error && error.code === "23505";
            if (!isUniqueViolation || attempt === MAX_GENERATION_ATTEMPTS - 1) {
                throw error;
            }
        }
    }

    throw new Error("Não foi possível gerar um código de vínculo único.");
}

interface LinkCodeRow {
    id: string;
    user_id: string;
    expires_at: Date;
    used_at: Date | null;
}

/** Valida e consome um código de vínculo, associando o chat à conta correspondente. */
export async function consumeLinkCode(code: string, chatId: number): Promise<LinkCodeOutcome> {
    const pool = getDatabasePool();
    const codeHash = hashLinkCode(code);

    const result = await pool.query<LinkCodeRow>(
        `SELECT id, user_id, expires_at, used_at
         FROM telegram_link_codes
         WHERE code_hash = $1;`,
        [codeHash]
    );

    const row = result.rows[0];
    if (!row || isLinkCodeUsed(row.used_at) || isLinkCodeExpired(new Date(row.expires_at))) {
        return { status: "invalid" };
    }

    const userId = Number(row.user_id);

    const chatConflict = await pool.query(
        "SELECT 1 FROM users WHERE telegram_chat_id = $1 AND id <> $2;",
        [chatId, userId]
    );
    if (chatConflict.rowCount && chatConflict.rowCount > 0) {
        return { status: "chat-already-linked" };
    }

    const userConflict = await pool.query(
        "SELECT 1 FROM users WHERE id = $1 AND telegram_chat_id IS NOT NULL AND telegram_chat_id <> $2;",
        [userId, chatId]
    );
    if (userConflict.rowCount && userConflict.rowCount > 0) {
        return { status: "user-already-linked" };
    }

    try {
        await pool.query("UPDATE users SET telegram_chat_id = $1 WHERE id = $2;", [chatId, userId]);
    } catch (error: unknown) {
        const isUniqueViolation = typeof error === "object" && error !== null
            && "code" in error && error.code === "23505";
        if (isUniqueViolation) {
            return { status: "chat-already-linked" };
        }
        throw error;
    }

    await pool.query(
        "UPDATE telegram_link_codes SET used_at = CURRENT_TIMESTAMP WHERE id = $1;",
        [row.id]
    );

    return { status: "linked", userId };
}

/** Remove o vínculo a partir do chat do Telegram (comando /desvincular). Retorna false se não havia vínculo. */
export async function unlinkChat(chatId: number): Promise<boolean> {
    const result = await getDatabasePool().query(
        "UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = $1 RETURNING id;",
        [chatId]
    );
    return (result.rowCount ?? 0) > 0;
}

/** Remove o vínculo a partir da conta autenticada no site. Retorna false se não havia vínculo. */
export async function unlinkUser(userId: number): Promise<boolean> {
    const result = await getDatabasePool().query(
        "UPDATE users SET telegram_chat_id = NULL WHERE id = $1 AND telegram_chat_id IS NOT NULL RETURNING id;",
        [userId]
    );
    return (result.rowCount ?? 0) > 0;
}

export async function getUserIdByChatId(chatId: number): Promise<number | undefined> {
    const result = await getDatabasePool().query<{ id: string }>(
        "SELECT id FROM users WHERE telegram_chat_id = $1;",
        [chatId]
    );
    const row = result.rows[0];
    return row ? Number(row.id) : undefined;
}
