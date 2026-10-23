import { getDatabasePool } from "../database/database.js";
import type { ConversationTurn } from "./bulaService.js";

export const CONVERSATION_HISTORY_LIMIT = 3;
export const CONVERSATION_HISTORY_WINDOW_MINUTES = 30;

export interface QueryHistoryEntry {
    id: number;
    question: string;
    answer: string;
    sources: string[];
    createdAt: Date;
}

interface QueryHistoryRow {
    id: string;
    question: string;
    answer: string;
    sources: unknown;
    created_at: Date;
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
        createdAt: row.created_at
    };
}

export async function saveQuery(
    userId: number,
    question: string,
    answer: string,
    sources: string[]
): Promise<QueryHistoryEntry> {
    const result = await getDatabasePool().query<QueryHistoryRow>(
        `INSERT INTO queries (user_id, question, answer, sources)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, question, answer, sources, created_at;`,
        [userId, question, answer, JSON.stringify(sources)]
    );

    return toQueryHistoryEntry(result.rows[0]);
}

export async function listQueries(userId: number): Promise<QueryHistoryEntry[]> {
    const result = await getDatabasePool().query<QueryHistoryRow>(
        `SELECT id, question, answer, sources, created_at
         FROM queries
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC;`,
        [userId]
    );

    return result.rows.map(toQueryHistoryEntry);
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
        `SELECT id, question, answer, sources, created_at
         FROM queries
         WHERE id = $1 AND user_id = $2;`,
        [id, userId]
    );

    if (!result.rows[0]) {
        throw new QueryNotFoundError();
    }

    return toQueryHistoryEntry(result.rows[0]);
}
