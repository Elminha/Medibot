import { escapeTelegramHtml, markdownToTelegramHtml } from "./telegramFormatting.js";
import type { QueryHistoryEntry } from "./queryHistoryService.js";

export const HISTORY_PAGE_SIZE = 5;
export const HISTORY_QUESTION_PREVIEW_LENGTH = 40;
export const HISTORY_BUTTON_PREVIEW_LENGTH = 28;

export const HISTORY_ITEM_NOT_FOUND_MESSAGE = "Essa consulta não está mais disponível.";

export interface HistoryPage {
    items: QueryHistoryEntry[];
    offset: number;
    hasPrevious: boolean;
    hasNext: boolean;
}

/**
 * Pagina uma lista já ordenada da mais recente para a mais antiga. Função pura
 * (sem acesso a banco) para que a paginação do /historico seja testável sem mock de DB.
 */
export function paginateHistory(
    entriesNewestFirst: QueryHistoryEntry[],
    offset: number,
    pageSize: number = HISTORY_PAGE_SIZE
): HistoryPage {
    const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const items = entriesNewestFirst.slice(safeOffset, safeOffset + pageSize);

    return {
        items,
        offset: safeOffset,
        hasPrevious: safeOffset > 0,
        hasNext: safeOffset + pageSize < entriesNewestFirst.length
    };
}

/**
 * Trunca por ponto de código (não por unidade UTF-16), para nunca cortar no meio
 * de um caractere especial (emoji, acento combinado etc.).
 */
export function truncateText(text: string, maxLength: number): string {
    const codePoints = Array.from(text.trim());
    if (codePoints.length <= maxLength) {
        return codePoints.join("");
    }
    return `${codePoints.slice(0, maxLength).join("")}…`;
}

export function formatChannelLabel(channel: string): string {
    return channel === "telegram" ? "Telegram" : "Site";
}

export function formatHistoryDateTime(date: Date, timeZone: string = "America/Sao_Paulo"): string {
    return new Intl.DateTimeFormat("pt-BR", {
        timeZone,
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    }).format(date);
}

export function formatHistoryListEntryLine(entry: QueryHistoryEntry, index: number): string {
    return `${index + 1}. ${formatHistoryDateTime(entry.createdAt)} · ${formatChannelLabel(entry.channel)}\n${truncateText(entry.question, HISTORY_QUESTION_PREVIEW_LENGTH)}`;
}

/** Texto (HTML simples) da mensagem de lista do /historico, incluindo os estados vazios. */
export function formatHistoryListMessage(page: HistoryPage): string {
    if (page.items.length === 0) {
        return page.offset > 0
            ? "Não há mais consultas para mostrar."
            : "Você ainda não tem consultas no histórico. Faça uma pergunta sobre um medicamento para começar.";
    }

    const lines = page.items.map((entry, index) => formatHistoryListEntryLine(entry, index));
    return ["Suas consultas mais recentes:", "", ...lines].join("\n\n");
}

export function formatHistoryButtonLabel(entry: QueryHistoryEntry, index: number): string {
    return `${index + 1}. ${truncateText(entry.question, HISTORY_BUTTON_PREVIEW_LENGTH)}`;
}

/** Monta o HTML (parse_mode HTML) do detalhe de uma consulta, sem o aviso educativo repetido. */
export function buildHistoryDetailHtml(entry: QueryHistoryEntry): string {
    let html = `<b>Pergunta:</b>\n${escapeTelegramHtml(entry.question)}\n\n<b>Resposta:</b>\n${markdownToTelegramHtml(entry.answer)}`;

    if (entry.sources.length > 0) {
        html += `\n\n<i>Fontes: ${escapeTelegramHtml(entry.sources.join(", "))}</i>`;
    }

    return html;
}

/**
 * Decide o texto a enviar para o detalhe de um item do histórico. `entry` já deve
 * vir filtrado por propriedade (ex.: `getQueryById(userId, id)`), então `null`
 * cobre tanto "não existe" quanto "pertence a outra conta" com a mesma mensagem,
 * sem revelar qual dos dois casos ocorreu.
 */
export function resolveHistoryDetailHtml(entry: QueryHistoryEntry | null): string {
    return entry ? buildHistoryDetailHtml(entry) : HISTORY_ITEM_NOT_FOUND_MESSAGE;
}
