import { getDatabasePool } from "../database/database.js";

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
