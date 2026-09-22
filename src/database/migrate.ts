import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabasePool, getDatabasePool, testDatabaseConnection } from "./database.js";

const migrationsDirectory = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations"
);

async function runMigrations(): Promise<void> {
    const pool = getDatabasePool();
    const client = await pool.connect();

    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                filename TEXT NOT NULL UNIQUE,
                executed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);

        const appliedMigrations = await client.query<{ filename: string }>(
            "SELECT filename FROM schema_migrations;"
        );
        const appliedFilenames = new Set(appliedMigrations.rows.map((row) => row.filename));
        const migrationFiles = (await readdir(migrationsDirectory))
            .filter((filename) => filename.endsWith(".sql"))
            .sort();

        for (const filename of migrationFiles) {
            if (appliedFilenames.has(filename)) {
                continue;
            }

            const migrationSql = await readFile(path.join(migrationsDirectory, filename), "utf8");

            await client.query("BEGIN");
            try {
                await client.query(migrationSql);
                await client.query(
                    "INSERT INTO schema_migrations (filename) VALUES ($1);",
                    [filename]
                );
                await client.query("COMMIT");
                console.log(`Migration executada: ${filename}`);
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
        }

        console.log("Migrations conclu\u00eddas com sucesso.");
    } finally {
        client.release();
    }
}

try {
    await testDatabaseConnection();
    await runMigrations();
} finally {
    await closeDatabasePool();
}
