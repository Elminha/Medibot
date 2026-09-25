import { getDatabasePool } from "../database/database.js";

const DEVELOPMENT_USER = {
    name: "MediBot Development User",
    phone: "MEDIBOT-DEVELOPMENT-USER",
    timezone: "America/Sao_Paulo"
} as const;

/**
 * Identidade temporária do MVP. Quando houver autenticação, este ponto deve
 * obter o ID do usuário autenticado em vez de criar/usar este usuário local.
 */
export async function getCurrentUserId(): Promise<number> {
    const pool = getDatabasePool();
    const existingUser = await pool.query<{ id: string }>(
        "SELECT id FROM users WHERE phone = $1;",
        [DEVELOPMENT_USER.phone]
    );

    if (existingUser.rows[0]) {
        return Number(existingUser.rows[0].id);
    }

    const createdUser = await pool.query<{ id: string }>(
        `INSERT INTO users (name, phone, timezone)
         VALUES ($1, $2, $3)
         ON CONFLICT (phone) DO NOTHING
         RETURNING id;`,
        [DEVELOPMENT_USER.name, DEVELOPMENT_USER.phone, DEVELOPMENT_USER.timezone]
    );

    if (createdUser.rows[0]) {
        return Number(createdUser.rows[0].id);
    }

    const concurrentUser = await pool.query<{ id: string }>(
        "SELECT id FROM users WHERE phone = $1;",
        [DEVELOPMENT_USER.phone]
    );

    if (!concurrentUser.rows[0]) {
        throw new Error("N\u00e3o foi poss\u00edvel obter o usu\u00e1rio de desenvolvimento.");
    }

    return Number(concurrentUser.rows[0].id);
}
