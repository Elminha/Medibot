import { getDatabasePool } from "../database/database.js";

export const FEEDBACK_TYPES = ["bug", "sugestao", "elogio", "outro"] as const;
export type FeedbackType = typeof FEEDBACK_TYPES[number];

export const FEEDBACK_VIEWS = ["chat", "historico", "medicamentos", "lembretes", "telegram"] as const;
export type FeedbackView = typeof FEEDBACK_VIEWS[number];

export const FEEDBACK_DEVICES = ["mobile", "desktop"] as const;
export type FeedbackDevice = typeof FEEDBACK_DEVICES[number];

export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;
export const FEEDBACK_HOURLY_LIMIT = 5;
export const FEEDBACK_DAILY_LIMIT = 20;

export interface FeedbackInput {
    type: FeedbackType;
    rating?: number;
    message: string;
    view: FeedbackView;
    device: FeedbackDevice;
    contactOk: boolean;
}

/** Subconjunto de `Pool.query` usado abaixo, para permitir injetar um pool falso nos testes. */
export interface QueryExecutor {
    query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export class FeedbackRateLimitError extends Error {
    constructor() {
        super("Você atingiu o limite de envios de feedback. Tente novamente mais tarde.");
        this.name = "FeedbackRateLimitError";
    }
}

export function isFeedbackType(value: unknown): value is FeedbackType {
    return typeof value === "string" && (FEEDBACK_TYPES as readonly string[]).includes(value);
}

export function isFeedbackView(value: unknown): value is FeedbackView {
    return typeof value === "string" && (FEEDBACK_VIEWS as readonly string[]).includes(value);
}

export function isFeedbackDevice(value: unknown): value is FeedbackDevice {
    return typeof value === "string" && (FEEDBACK_DEVICES as readonly string[]).includes(value);
}

export function isValidFeedbackRating(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

/** Corta espaços nas pontas e exige 1 a 2000 caracteres; undefined se inválida. */
export function validateFeedbackMessage(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
        return undefined;
    }

    return trimmed;
}

/** Função pura: decide só a partir das contagens já calculadas, sem depender do banco. */
export function hasExceededFeedbackRateLimit(hourlyCount: number, dailyCount: number): boolean {
    return hourlyCount >= FEEDBACK_HOURLY_LIMIT || dailyCount >= FEEDBACK_DAILY_LIMIT;
}

async function countFeedbackSince(userId: number, since: Date, executor: QueryExecutor): Promise<number> {
    const result = await executor.query(
        `SELECT COUNT(*) AS count FROM feedback WHERE user_id = $1 AND created_at >= $2;`,
        [userId, since]
    );
    const row = result.rows[0] as { count: string } | undefined;
    return Number(row?.count ?? 0);
}

/**
 * Registra um feedback, depois de checar o limite por usuário (5/hora e 20/dia,
 * contados na própria tabela). Lança FeedbackRateLimitError se excedido; nunca
 * registra `input.message` em log algum.
 */
export async function createFeedback(
    userId: number,
    input: FeedbackInput,
    now: Date = new Date(),
    executor: QueryExecutor = getDatabasePool()
): Promise<void> {
    const sinceHour = new Date(now.getTime() - 60 * 60_000);
    const sinceDay = new Date(now.getTime() - 24 * 60 * 60_000);

    const [hourlyCount, dailyCount] = await Promise.all([
        countFeedbackSince(userId, sinceHour, executor),
        countFeedbackSince(userId, sinceDay, executor)
    ]);

    if (hasExceededFeedbackRateLimit(hourlyCount, dailyCount)) {
        throw new FeedbackRateLimitError();
    }

    await executor.query(
        `INSERT INTO feedback (user_id, type, rating, message, view, device, contact_ok)
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [userId, input.type, input.rating ?? null, input.message, input.view, input.device, input.contactOk]
    );
}
