export const TELEGRAM_MESSAGE_LIMIT = 4000;

export const TELEGRAM_SAFETY_NOTICE =
    "Esta resposta é educativa e não substitui a orientação de um profissional de saúde.";

/** Escapa os três caracteres que o Telegram exige escapados em parse_mode HTML. */
export function escapeTelegramHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function convertInlineMarkdown(escapedLine: string): string {
    return escapedLine
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/__(.+?)__/g, "<b>$1</b>")
        .replace(/`([^`]+?)`/g, "<code>$1</code>")
        .replace(/(?<![*_\w])\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>")
        .replace(/(?<![*_\w])_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");
}

function convertLine(rawLine: string): string {
    const escaped = escapeTelegramHtml(rawLine);

    const headingMatch = escaped.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
        return `<b>${convertInlineMarkdown(headingMatch[2])}</b>`;
    }

    const bulletMatch = escaped.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
        return `• ${convertInlineMarkdown(bulletMatch[1])}`;
    }

    return convertInlineMarkdown(escaped);
}

/**
 * Converte markdown simples (###, **, *, _, `, listas com - ou *) para o
 * subconjunto de HTML aceito pelo Telegram (parse_mode "HTML"). O texto original
 * é escapado antes de qualquer substituição, então as únicas tags presentes no
 * resultado são as que esta função insere.
 */
export function markdownToTelegramHtml(markdown: string): string {
    return markdown
        .split("\n")
        .map(convertLine)
        .join("\n");
}

/**
 * Divide um texto já convertido para HTML em partes de até `limit` caracteres,
 * quebrando apenas em fins de linha para não cortar uma tag HTML pela metade.
 * Um único "parágrafo" sem quebra de linha que ainda assim exceda o limite é
 * cortado por caractere como último recurso.
 */
export function splitTelegramMessage(html: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string[] {
    if (html.length <= limit) {
        return html.length > 0 ? [html] : [];
    }

    const parts: string[] = [];
    let current = "";

    for (const line of html.split("\n")) {
        const candidate = current ? `${current}\n${line}` : line;

        if (candidate.length <= limit) {
            current = candidate;
            continue;
        }

        if (current) {
            parts.push(current);
            current = "";
        }

        if (line.length <= limit) {
            current = line;
            continue;
        }

        for (let offset = 0; offset < line.length; offset += limit) {
            parts.push(line.slice(offset, offset + limit));
        }
    }

    if (current) {
        parts.push(current);
    }

    return parts;
}
