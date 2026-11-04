import { getOccurrencesInWindow, type OccurrenceReminder } from "./reminderOccurrences.js";
import { isEmailVerificationRequired } from "./emailVerificationService.js";

export const DEFAULT_WINDOW_MS = 5 * 60_000;
export const DEFAULT_STUCK_SENDING_AFTER_MS = 2 * 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_SENDS_PER_RUN = 100;
export const DEFAULT_CONCURRENCY = 5;

/** Monta a mensagem enviada ao usuário. Texto puro, sem markdown/HTML, sem dose nem recomendação médica. */
export function buildReminderMessage(medicationName: string, time: string): string {
    return `💊 Hora do medicamento: ${medicationName} (${time})`;
}

export interface TelegramSendError {
    error_code?: number;
    parameters?: { retry_after?: number };
    message?: string;
}

function isTelegramSendError(error: unknown): error is TelegramSendError {
    return typeof error === "object" && error !== null;
}

/**
 * Nunca grava a mensagem completa de uma exceção em reminder_deliveries.error (pode
 * conter detalhes técnicos sensíveis da lib do Telegram) — só um código curto.
 */
export function summarizeDispatchError(error: unknown): string {
    if (isTelegramSendError(error)) {
        const code = (error as { error_code?: number }).error_code;
        if (code === 403) {
            return "blocked";
        }
        if (code === 429) {
            const retryAfter = (error as TelegramSendError).parameters?.retry_after;
            return `rate_limited:${typeof retryAfter === "number" ? retryAfter : "unknown"}`;
        }
    }
    return "send_failed";
}

function isDefinitiveBlock(error: unknown): boolean {
    return isTelegramSendError(error) && (error as { error_code?: number }).error_code === 403;
}

function isRateLimited(error: unknown): boolean {
    return isTelegramSendError(error) && (error as { error_code?: number }).error_code === 429;
}

export interface TelegramSender {
    sendMessage(chatId: number, text: string): Promise<void>;
}

interface QueryResult<T> {
    rows: T[];
    rowCount: number | null;
}

export interface DispatchPool {
    query: <T = unknown>(text: string, params?: unknown[]) => Promise<QueryResult<T>>;
}

interface DispatchCandidateRow {
    reminder_id: string;
    medication_name: string;
    active: boolean;
    starts_on: string;
    ends_on: string | null;
    times: string[] | null;
    weekdays: number[] | null;
    chat_id: string | null;
    email: string | null;
    email_verified_at: string | Date | null;
}

export interface DispatchCandidate extends OccurrenceReminder {
    id: number;
    medicationName: string;
    chatId: number | undefined;
    // Conta sem e-mail (legado) é tratada como verificada: nada para confirmar.
    emailVerified: boolean;
}

/**
 * Candidatos a despacho por Telegram: lembretes ativos com o canal "telegram"
 * selecionado, buscados a CADA execução (sem cache) para refletir edições, pausas,
 * exclusões e (des)vínculos feitos entre uma chamada e outra. chat_id pode vir nulo —
 * quem chama decide o que fazer (hoje: registrar como "skipped").
 */
export async function fetchTelegramDispatchCandidates(pool: DispatchPool): Promise<DispatchCandidate[]> {
    const result = await pool.query<DispatchCandidateRow>(
        `SELECT
            r.id AS reminder_id,
            m.name AS medication_name,
            r.active,
            to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on,
            to_char(r.ends_on, 'YYYY-MM-DD') AS ends_on,
            COALESCE(
                (SELECT array_agg(to_char(rt."time", 'HH24:MI') ORDER BY rt."time")
                 FROM reminder_times rt WHERE rt.reminder_id = r.id),
                '{}'
            ) AS times,
            COALESCE(
                (SELECT array_agg(rw.weekday ORDER BY rw.weekday)
                 FROM reminder_weekdays rw WHERE rw.reminder_id = r.id),
                '{}'
            ) AS weekdays,
            u.telegram_chat_id AS chat_id,
            u.email AS email,
            u.email_verified_at AS email_verified_at
         FROM reminders r
         INNER JOIN reminder_channels rc ON rc.reminder_id = r.id AND rc.channel = 'telegram'
         INNER JOIN medications m ON m.id = r.medication_id
         INNER JOIN users u ON u.id = m.user_id
         WHERE r.active = true;`
    );

    return result.rows.map((row) => ({
        id: Number(row.reminder_id),
        medicationName: row.medication_name,
        active: row.active,
        times: row.times ?? [],
        weekdays: row.weekdays ?? [],
        startsOn: row.starts_on,
        endsOn: row.ends_on,
        chatId: row.chat_id !== null ? Number(row.chat_id) : undefined,
        emailVerified: row.email === null || row.email_verified_at !== null
    }));
}

interface ClaimResult {
    id: number;
    attempts: number;
}

/**
 * Reivindica atomicamente uma ocorrência (reminder_id, 'telegram', occurrence_at) para
 * esta execução enviar. Pode reivindicar quando: a linha não existe ainda (primeira
 * tentativa), está 'pending' (retentativa dentro da janela) ou está 'sending' há mais
 * de `stuckAfterMs` (execução anterior morreu no meio do envio, ex.: timeout da
 * function serverless). Devolve null quando outra execução já está processando agora,
 * ou quando a ocorrência já foi resolvida (sent/failed/skipped).
 */
async function claimDelivery(
    pool: DispatchPool,
    reminderId: number,
    occurrenceAt: Date,
    stuckAfterMs: number
): Promise<ClaimResult | null> {
    const result = await pool.query<{ id: string; attempts: number }>(
        `INSERT INTO reminder_deliveries (reminder_id, channel, occurrence_at, status, attempts, updated_at)
         VALUES ($1, 'telegram', $2, 'sending', 1, CURRENT_TIMESTAMP)
         ON CONFLICT (reminder_id, channel, occurrence_at) DO UPDATE
             SET status = 'sending', attempts = reminder_deliveries.attempts + 1, updated_at = CURRENT_TIMESTAMP
             WHERE reminder_deliveries.status = 'pending'
                OR (reminder_deliveries.status = 'sending'
                    AND reminder_deliveries.updated_at < CURRENT_TIMESTAMP - (INTERVAL '1 millisecond' * $3))
         RETURNING id, attempts;`,
        [reminderId, occurrenceAt, stuckAfterMs]
    );

    const row = result.rows[0];
    return row ? { id: Number(row.id), attempts: Number(row.attempts) } : null;
}

async function insertSkippedDelivery(pool: DispatchPool, reminderId: number, occurrenceAt: Date): Promise<boolean> {
    const result = await pool.query(
        `INSERT INTO reminder_deliveries (reminder_id, channel, occurrence_at, status, attempts, updated_at)
         VALUES ($1, 'telegram', $2, 'skipped', 0, CURRENT_TIMESTAMP)
         ON CONFLICT (reminder_id, channel, occurrence_at) DO NOTHING
         RETURNING id;`,
        [reminderId, occurrenceAt]
    );
    return (result.rowCount ?? 0) > 0;
}

async function markDeliverySent(pool: DispatchPool, id: number): Promise<void> {
    await pool.query(
        `UPDATE reminder_deliveries SET status = 'sent', sent_at = CURRENT_TIMESTAMP, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
        [id]
    );
}

async function markDeliveryPending(pool: DispatchPool, id: number, errorSummary: string): Promise<void> {
    await pool.query(
        `UPDATE reminder_deliveries SET status = 'pending', error = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
        [id, errorSummary]
    );
}

async function markDeliveryFailed(pool: DispatchPool, id: number, errorSummary: string): Promise<void> {
    await pool.query(
        `UPDATE reminder_deliveries SET status = 'failed', error = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
        [id, errorSummary]
    );
}

export interface DispatchSummary {
    candidates: number;
    occurrencesInWindow: number;
    sent: number;
    skipped: number;
    failed: number;
    expiredOutsideWindow: number;
}

export interface DispatchDeps {
    pool: DispatchPool;
    sender: TelegramSender;
    now: () => Date;
    windowMs?: number;
    stuckAfterMs?: number;
    maxAttempts?: number;
    maxSendsPerRun?: number;
    concurrency?: number;
}

export interface DispatchOptions {
    dryRun: boolean;
}

interface DueItem {
    candidate: DispatchCandidate;
    occurrenceAt: Date;
    time: string;
}

async function processBatches<T>(items: T[], concurrency: number, handler: (item: T) => Promise<void>): Promise<void> {
    for (let start = 0; start < items.length; start += concurrency) {
        const batch = items.slice(start, start + concurrency);
        await Promise.all(batch.map(handler));
    }
}

/**
 * Ponto de entrada do despachante (chamado pela rota interna). Sem acesso a rede/Telegram
 * real nos testes: `sender` e `now` são injetados (ver tests/reminderDispatchService.test.ts).
 */
export async function runReminderDispatch(deps: DispatchDeps, options: DispatchOptions): Promise<DispatchSummary> {
    const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
    const stuckAfterMs = deps.stuckAfterMs ?? DEFAULT_STUCK_SENDING_AFTER_MS;
    const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const maxSendsPerRun = deps.maxSendsPerRun ?? DEFAULT_MAX_SENDS_PER_RUN;
    const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

    const candidates = await fetchTelegramDispatchCandidates(deps.pool);
    const now = deps.now();

    const dueItems: DueItem[] = [];
    let expiredOutsideWindow = 0;

    for (const candidate of candidates) {
        const { due, expired } = getOccurrencesInWindow(candidate, now, windowMs);
        expiredOutsideWindow += expired.length;
        for (const occurrence of due) {
            const time = occurrence.key.split("T")[1];
            dueItems.push({ candidate, occurrenceAt: new Date(occurrence.at), time });
        }
    }

    if (expiredOutsideWindow > 0) {
        console.warn(
            `Despachante de lembretes: ${expiredOutsideWindow} ocorrência(s) vencida(s) fora da janela de ${Math.round(windowMs / 60_000)} min (perdidas).`
        );
    }

    const summary: DispatchSummary = {
        candidates: candidates.length,
        occurrencesInWindow: dueItems.length,
        sent: 0,
        skipped: 0,
        failed: 0,
        expiredOutsideWindow
    };

    // Enquanto a flag estiver ligada, conta vinculada mas com e-mail pendente de
    // confirmação não recebe lembretes (mesmo bloqueio do site e do bot, ver
    // requireVerifiedEmail/telegramBot.ts), tratada como "sem destino" para o envio.
    const blockUnverified = isEmailVerificationRequired();
    const isUnsendable = (item: DueItem): boolean =>
        item.candidate.chatId === undefined || (blockUnverified && !item.candidate.emailVerified);

    if (options.dryRun) {
        summary.skipped = dueItems.filter(isUnsendable).length;
        return summary;
    }

    const skippedItems = dueItems.filter(isUnsendable);
    for (const item of skippedItems) {
        try {
            await insertSkippedDelivery(deps.pool, item.candidate.id, item.occurrenceAt);
            summary.skipped += 1;
        } catch (error) {
            // O lembrete (ou a conta) pode ter sido apagado entre a busca de candidatos e
            // aqui (ex.: exclusão da própria conta em paralelo, ver accountService.ts): a
            // FK para reminders passa a falhar, mas isso nunca pode derrubar o restante do
            // lote, que é de outros usuários.
            console.error(`Despachante de lembretes: não foi possível registrar 'skipped' para o lembrete ${item.candidate.id}.`, error);
        }
    }

    const sendableItems = dueItems
        .filter((item) => !isUnsendable(item))
        .slice(0, maxSendsPerRun);

    await processBatches(sendableItems, concurrency, async (item) => {
        let claimed: ClaimResult | null;
        try {
            claimed = await claimDelivery(deps.pool, item.candidate.id, item.occurrenceAt, stuckAfterMs);
        } catch (error) {
            console.error(`Despachante de lembretes: não foi possível reivindicar o envio do lembrete ${item.candidate.id}.`, error);
            return;
        }
        if (!claimed) {
            return;
        }

        if (claimed.attempts > maxAttempts) {
            await markDeliveryFailed(deps.pool, claimed.id, "attempts_exhausted");
            summary.failed += 1;
            return;
        }

        try {
            const message = buildReminderMessage(item.candidate.medicationName, item.time);
            await deps.sender.sendMessage(item.candidate.chatId as number, message);
            await markDeliverySent(deps.pool, claimed.id);
            summary.sent += 1;
        } catch (error) {
            const errorSummary = summarizeDispatchError(error);

            if (isDefinitiveBlock(error)) {
                await markDeliveryFailed(deps.pool, claimed.id, errorSummary);
                summary.failed += 1;
                return;
            }

            if (isRateLimited(error)) {
                // Nunca espera dentro da invocação: devolve para 'pending' e deixa o
                // retry_after implícito na janela de 5 min / próxima execução por minuto.
                await markDeliveryPending(deps.pool, claimed.id, errorSummary);
                return;
            }

            if (claimed.attempts >= maxAttempts) {
                await markDeliveryFailed(deps.pool, claimed.id, errorSummary);
                summary.failed += 1;
            } else {
                await markDeliveryPending(deps.pool, claimed.id, errorSummary);
            }
        }
    });

    return summary;
}
