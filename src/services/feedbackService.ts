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

/**
 * Namespace arbitrário para o advisory lock do feedback (forma de duas chaves:
 * pg_advisory_xact_lock(namespace, userId)). Advisory locks do Postgres compartilham um
 * único keyspace por banco; se alguma outra feature travar diretamente por userId
 * (pg_advisory_xact_lock(userId), uma única chave), colidiria com este lock sem querer.
 * A chave composta reserva um "namespace" só para o feedback e evita esse risco.
 */
const FEEDBACK_ADVISORY_LOCK_NAMESPACE = 913_820_001;

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

/** Subconjunto de `Pool.connect()` (cliente dedicado para a transação), para permitir injetar um pool falso nos testes. */
export interface PoolExecutor {
    connect: () => Promise<QueryExecutor & { release: () => void }>;
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
 * Registra um feedback, depois de checar o limite por usuário (5/hora e 20/dia, numa
 * janela móvel contada na própria tabela: "últimos 60/1440 minutos a partir de `now`",
 * não um recorte por hora/dia do relógio).
 *
 * A checagem das contagens e o INSERT rodam na mesma transação, com um
 * pg_advisory_xact_lock por usuário: sem isso, duas requisições simultâneas do mesmo
 * usuário poderiam ambas contar, por exemplo, 4 envios na última hora, ambas passarem
 * da checagem (4 < 5) e ambas inserirem — superando o limite em 1. O lock serializa
 * as requisições do mesmo usuário (outros usuários não são afetados) e é liberado
 * automaticamente no fim da transação.
 *
 * Lança FeedbackRateLimitError se excedido; nunca registra `input.message` em log algum.
 */
export async function createFeedback(
    userId: number,
    input: FeedbackInput,
    now: Date = new Date(),
    pool: PoolExecutor = getDatabasePool()
): Promise<void> {
    const sinceHour = new Date(now.getTime() - 60 * 60_000);
    const sinceDay = new Date(now.getTime() - 24 * 60 * 60_000);

    const client = await pool.connect();
    try {
        await client.query("BEGIN;");
        await client.query(
            "SELECT pg_advisory_xact_lock($1, $2);",
            [FEEDBACK_ADVISORY_LOCK_NAMESPACE, userId]
        );

        const hourlyCount = await countFeedbackSince(userId, sinceHour, client);
        const dailyCount = await countFeedbackSince(userId, sinceDay, client);

        if (hasExceededFeedbackRateLimit(hourlyCount, dailyCount)) {
            await client.query("ROLLBACK;");
            throw new FeedbackRateLimitError();
        }

        await client.query(
            `INSERT INTO feedback (user_id, type, rating, message, view, device, contact_ok)
             VALUES ($1, $2, $3, $4, $5, $6, $7);`,
            [userId, input.type, input.rating ?? null, input.message, input.view, input.device, input.contactOk]
        );
        await client.query("COMMIT;");
    } catch (error) {
        if (!(error instanceof FeedbackRateLimitError)) {
            await client.query("ROLLBACK;").catch(() => {});
        }
        throw error;
    } finally {
        client.release();
    }
}
