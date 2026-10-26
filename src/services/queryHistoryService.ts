import { getDatabasePool } from "../database/database.js";
import type { ConversationTurn } from "./bulaService.js";

export const CONVERSATION_HISTORY_LIMIT = 3;
export const CONVERSATION_HISTORY_WINDOW_MINUTES = 30;

export type QueryChannel = "site" | "telegram";

export interface QueryHistoryEntry {
    id: number;
    question: string;
    answer: string;
    sources: string[];
    channel: QueryChannel;
    createdAt: Date;
}

interface QueryHistoryRow {
    id: string;
    question: string;
    answer: string;
    sources: unknown;
    channel: string;
    created_at: Date;
}

/**
 * Subconjunto de `Pool.query` usado pelas funções de apagar/contar abaixo.
 * Permite injetar um "pool" falso nos testes sem depender de um banco real.
 */
export interface QueryExecutor {
    query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export class QueryNotFoundError extends Error {
    constructor() {
        super("Consulta não encontrada.");
        this.name = "QueryNotFoundError";
    }
}

function toSources(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((source): source is string => typeof source === "string")
        : [];
}

function toQueryHistoryEntry(row: QueryHistoryRow): QueryHistoryEntry {
    return {
        id: Number(row.id),
        question: row.question,
        answer: row.answer,
        sources: toSources(row.sources),
        channel: row.channel === "telegram" ? "telegram" : "site",
        createdAt: row.created_at
    };
}

export async function saveQuery(
    userId: number,
    question: string,
    answer: string,
    sources: string[],
    channel: QueryChannel
): Promise<QueryHistoryEntry> {
    const result = await getDatabasePool().query<QueryHistoryRow>(
        `INSERT INTO queries (user_id, question, answer, sources, channel)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, question, answer, sources, channel, created_at;`,
        [userId, question, answer, JSON.stringify(sources), channel]
    );

    return toQueryHistoryEntry(result.rows[0]);
}

export async function listQueries(userId: number): Promise<QueryHistoryEntry[]> {
    const result = await getDatabasePool().query<QueryHistoryRow>(
        `SELECT id, question, answer, sources, channel, created_at
         FROM queries
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC;`,
        [userId]
    );

    return result.rows.map(toQueryHistoryEntry);
}

/** Conta todas as consultas do usuário, de qualquer canal (usado ao vincular o Telegram). */
export async function countQueries(userId: number): Promise<number> {
    const result = await getDatabasePool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM queries WHERE user_id = $1;`,
        [userId]
    );
    return Number(result.rows[0]?.count ?? 0);
}

/** Conta apenas as consultas feitas pelo Telegram (usado pela confirmação do /apagar). */
export async function countTelegramQueries(
    userId: number,
    executor: QueryExecutor = getDatabasePool()
): Promise<number> {
    const result = await executor.query(
        `SELECT COUNT(*) AS count FROM queries WHERE user_id = $1 AND channel = 'telegram';`,
        [userId]
    );
    const row = result.rows[0] as { count: string } | undefined;
    return Number(row?.count ?? 0);
}

/** Apaga apenas as consultas feitas pelo Telegram (comando /apagar). Retorna quantas foram apagadas. */
export async function deleteTelegramQueries(
    userId: number,
    executor: QueryExecutor = getDatabasePool()
): Promise<number> {
    const result = await executor.query(
        `DELETE FROM queries WHERE user_id = $1 AND channel = 'telegram';`,
        [userId]
    );
    return result.rowCount ?? 0;
}

/** Apaga uma única consulta, somente se pertencer ao usuário. Retorna false se não existir ou for de outra conta. */
export async function deleteQuery(
    userId: number,
    id: number,
    executor: QueryExecutor = getDatabasePool()
): Promise<boolean> {
    const result = await executor.query(
        `DELETE FROM queries WHERE id = $1 AND user_id = $2;`,
        [id, userId]
    );
    return (result.rowCount ?? 0) > 0;
}

/** Conta quantas consultas o usuário fez desde `since` (usado para limitar o uso do bot do Telegram). */
export async function countQueriesSince(userId: number, since: Date): Promise<number> {
    const result = await getDatabasePool().query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM queries
         WHERE user_id = $1 AND created_at >= $2;`,
        [userId, since]
    );

    return Number(result.rows[0]?.count ?? 0);
}

/**
 * A partir de entradas já ordenadas da mais recente para a mais antiga, seleciona
 * as últimas `limit` trocas dentro da janela de tempo e devolve em ordem
 * cronológica (mais antiga primeiro), pronta para compor o contexto enviado ao modelo.
 */
export function selectRecentConversationTurns(
    entriesNewestFirst: QueryHistoryEntry[],
    now: Date = new Date(),
    limit: number = CONVERSATION_HISTORY_LIMIT,
    windowMinutes: number = CONVERSATION_HISTORY_WINDOW_MINUTES
): ConversationTurn[] {
    const sinceMs = now.getTime() - windowMinutes * 60_000;

    return entriesNewestFirst
        .filter((entry) => entry.createdAt.getTime() >= sinceMs)
        .slice(0, limit)
        .reverse()
        .map(({ question, answer, sources }) => ({ question, answer, sources }));
}

/** Busca as últimas trocas recentes do usuário (limite e janela de tempo padrão), em ordem cronológica. */
export async function getRecentConversationTurns(
    userId: number,
    now: Date = new Date()
): Promise<ConversationTurn[]> {
    const since = new Date(now.getTime() - CONVERSATION_HISTORY_WINDOW_MINUTES * 60_000);

    const result = await getDatabasePool().query<QueryHistoryRow>(
        `SELECT id, question, answer, sources, created_at
         FROM queries
         WHERE user_id = $1 AND created_at >= $2
         ORDER BY created_at DESC, id DESC
         LIMIT $3;`,
        [userId, since, CONVERSATION_HISTORY_LIMIT]
    );

    return selectRecentConversationTurns(result.rows.map(toQueryHistoryEntry), now);
}

export async function getQueryById(userId: number, id: number): Promise<QueryHistoryEntry> {
    const result = await getDatabasePool().query<QueryHistoryRow>(
        `SELECT id, question, answer, sources, channel, created_at
         FROM queries
         WHERE id = $1 AND user_id = $2;`,
        [id, userId]
    );

    if (!result.rows[0]) {
        throw new QueryNotFoundError();
    }

    return toQueryHistoryEntry(result.rows[0]);
}
