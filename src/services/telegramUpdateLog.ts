import { getDatabasePool } from "../database/database.js";

/**
 * Registra um update_id do Telegram como processado. Retorna `true` na primeira
 * vez que esse update é visto e `false` se já havia sido processado antes
 * (reenvio do Telegram por timeout), para que o chamador possa ignorá-lo sem
 * depender de estado em memória (que não sobrevive entre instâncias serverless).
 */
export async function registerUpdateOnce(updateId: number, chatId: number): Promise<boolean> {
    const result = await getDatabasePool().query(
        `INSERT INTO telegram_processed_updates (update_id, chat_id)
         VALUES ($1, $2)
         ON CONFLICT (update_id) DO NOTHING
         RETURNING update_id;`,
        [updateId, chatId]
    );

    return (result.rowCount ?? 0) > 0;
}
