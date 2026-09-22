import "dotenv/config";
import { Pool, type PoolConfig } from "pg";

const requiredDatabaseVariables = [
    "DATABASE_HOST",
    "DATABASE_PORT",
    "DATABASE_NAME",
    "DATABASE_USER",
    "DATABASE_PASSWORD"
] as const;

let pool: Pool | undefined;

function getDatabaseConfig(): PoolConfig {
    const missingVariables = requiredDatabaseVariables.filter(
        (variable) => !process.env[variable]?.trim()
    );

    if (missingVariables.length > 0) {
        throw new Error(
            `Configura\u00e7\u00e3o do banco de dados incompleta. Defina: ${missingVariables.join(", ")}.`
        );
    }

    const port = Number(process.env.DATABASE_PORT);

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error("DATABASE_PORT deve ser uma porta v\u00e1lida entre 1 e 65535.");
    }

    return {
        host: process.env.DATABASE_HOST,
        port,
        database: process.env.DATABASE_NAME,
        user: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD
    };
}

/** Retorna o pool compartilhado de conex\u00f5es com o PostgreSQL. */
export function getDatabasePool(): Pool {
    if (!pool) {
        pool = new Pool(getDatabaseConfig());
    }

    return pool;
}

/** Verifica a conectividade com o PostgreSQL sem expor credenciais. */
export async function testDatabaseConnection(): Promise<Date> {
    const result = await getDatabasePool().query<{ current_time: Date }>(
        "SELECT NOW() AS current_time;"
    );
    const connectedAt = result.rows[0].current_time;

    console.log("Conex\u00e3o com o PostgreSQL realizada com sucesso.");
    return connectedAt;
}

/** Finaliza o pool compartilhado, para uso por scripts de linha de comando. */
export async function closeDatabasePool(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = undefined;
    }
}
