import { getDatabasePool } from "../database/database.js";

/**
 * Prazo a partir do qual um update ainda marcado como "processing" é considerado morto
 * (ex.: a instância serverless foi encerrada no meio do processamento) e pode ser
 * reivindicado de novo. Deve ficar acima do timeout do webhook (ver
 * TELEGRAM_WEBHOOK_TIMEOUT_MS em telegramRoutes.ts) para nunca reivindicar uma tentativa
 * que ainda está legitimamente em andamento.
 */
export const PROCESSING_DEAD_AFTER_MS = 90_000;

/**
 * Reivindica um update_id para processamento nesta invocação. Retorna `true` quando
 * esta chamada deve processar o update (primeira vez, ou uma tentativa anterior que
 * morreu no meio e passou do prazo), e `false` quando deve ser ignorado (já concluído,
 * ou outra entrega do mesmo update_id está processando agora).
 *
 * A reivindicação é atômica: um único INSERT ... ON CONFLICT ... DO UPDATE ... WHERE
 * garante que duas entregas simultâneas do mesmo update_id nunca reivindiquem as duas
 * (a segunda só atualiza a linha se o WHERE da condição de "morto" for satisfeito).
 */
export async function claimUpdateForProcessing(updateId: number, chatId: number): Promise<boolean> {
    const result = await getDatabasePool().query(
        `INSERT INTO telegram_processed_updates (update_id, chat_id, status, started_at)
         VALUES ($1, $2, 'processing', CURRENT_TIMESTAMP)
         ON CONFLICT (update_id) DO UPDATE
             SET started_at = EXCLUDED.started_at,
                 chat_id = EXCLUDED.chat_id
             WHERE telegram_processed_updates.status = 'processing'
               AND telegram_processed_updates.started_at < CURRENT_TIMESTAMP - (INTERVAL '1 millisecond' * $3)
         RETURNING update_id;`,
        [updateId, chatId, PROCESSING_DEAD_AFTER_MS]
    );

    return (result.rowCount ?? 0) > 0;
}

/** Marca um update como concluído com sucesso: nunca mais deve ser reprocessado. */
export async function markUpdateDone(updateId: number): Promise<void> {
    await getDatabasePool().query(
        `UPDATE telegram_processed_updates SET status = 'done' WHERE update_id = $1;`,
        [updateId]
    );
}

/**
 * Libera um update para nova tentativa imediatamente (sem esperar o prazo de "morto"),
 * usado quando o processamento falhou de forma tratada (ex.: timeout da OpenAI).
 */
export async function releaseUpdateForRetry(updateId: number): Promise<void> {
    await getDatabasePool().query(
        `UPDATE telegram_processed_updates
         SET status = 'processing',
             started_at = CURRENT_TIMESTAMP - (INTERVAL '1 millisecond' * $2)
         WHERE update_id = $1;`,
        [updateId, PROCESSING_DEAD_AFTER_MS + 1_000]
    );
}
