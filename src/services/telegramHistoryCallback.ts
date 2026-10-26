/**
 * callback_data dos botões inline do /historico e do /apagar. Formato curto e
 * determinístico, bem abaixo do limite de 64 bytes do Telegram:
 *   - "h:p:<offset>"        -> página da lista (Ver mais / Anterior)
 *   - "h:o:<id>:<offset>"   -> abrir um item (guarda o offset para "Voltar à lista")
 *   - "a:y:<minutosEpoch>"  -> confirmar o /apagar (carimbo de tempo p/ expirar em 5 min)
 *   - "a:n"                 -> cancelar o /apagar
 */

export type HistoryCallbackAction =
    | { type: "page"; offset: number }
    | { type: "open"; id: number; offset: number };

const HISTORY_PAGE_PREFIX = "h:p:";
const HISTORY_OPEN_PREFIX = "h:o:";
const DELETE_CONFIRM_PREFIX = "a:y:";
export const DELETE_CANCEL_CALLBACK_DATA = "a:n";
export const DELETE_CONFIRMATION_TTL_MINUTES = 5;

const MAX_CALLBACK_DATA_BYTES = 64;
const NON_NEGATIVE_INTEGER = /^\d+$/;

function isSafeNonNegativeInteger(value: string): boolean {
    if (!NON_NEGATIVE_INTEGER.test(value)) {
        return false;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0;
}

export function buildHistoryPageCallbackData(offset: number): string {
    return `${HISTORY_PAGE_PREFIX}${Math.max(0, Math.trunc(offset))}`;
}

export function buildHistoryOpenCallbackData(id: number, offset: number): string {
    return `${HISTORY_OPEN_PREFIX}${Math.max(0, Math.trunc(id))}:${Math.max(0, Math.trunc(offset))}`;
}

/** Faz o parse com rigor: qualquer formato inesperado retorna null (ignorado pelo chamador). */
export function parseHistoryCallbackData(data: string): HistoryCallbackAction | null {
    if (typeof data !== "string" || data.length === 0 || data.length > MAX_CALLBACK_DATA_BYTES) {
        return null;
    }

    if (data.startsWith(HISTORY_PAGE_PREFIX)) {
        const offsetPart = data.slice(HISTORY_PAGE_PREFIX.length);
        if (!isSafeNonNegativeInteger(offsetPart)) {
            return null;
        }
        return { type: "page", offset: Number(offsetPart) };
    }

    if (data.startsWith(HISTORY_OPEN_PREFIX)) {
        const rest = data.slice(HISTORY_OPEN_PREFIX.length);
        const separatorIndex = rest.indexOf(":");
        if (separatorIndex <= 0 || separatorIndex === rest.length - 1) {
            return null;
        }
        const idPart = rest.slice(0, separatorIndex);
        const offsetPart = rest.slice(separatorIndex + 1);
        if (!isSafeNonNegativeInteger(idPart) || !isSafeNonNegativeInteger(offsetPart)) {
            return null;
        }
        const id = Number(idPart);
        if (id <= 0) {
            return null;
        }
        return { type: "open", id, offset: Number(offsetPart) };
    }

    return null;
}

export function buildDeleteConfirmCallbackData(nowMinutesSinceEpoch: number): string {
    return `${DELETE_CONFIRM_PREFIX}${Math.max(0, Math.trunc(nowMinutesSinceEpoch))}`;
}

export function parseDeleteConfirmCallbackData(data: string): { minutesSinceEpoch: number } | null {
    if (typeof data !== "string" || !data.startsWith(DELETE_CONFIRM_PREFIX)) {
        return null;
    }
    const rest = data.slice(DELETE_CONFIRM_PREFIX.length);
    if (!isSafeNonNegativeInteger(rest)) {
        return null;
    }
    return { minutesSinceEpoch: Number(rest) };
}

export function currentMinutesSinceEpoch(now: Date = new Date()): number {
    return Math.floor(now.getTime() / 60_000);
}

export function isDeleteConfirmationExpired(
    confirmationMinutesSinceEpoch: number,
    nowMinutesSinceEpoch: number = currentMinutesSinceEpoch(),
    ttlMinutes: number = DELETE_CONFIRMATION_TTL_MINUTES
): boolean {
    return nowMinutesSinceEpoch - confirmationMinutesSinceEpoch > ttlMinutes;
}
