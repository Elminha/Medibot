import test from "node:test";
import assert from "node:assert/strict";
import {
    buildHistoryDetailHtml,
    formatChannelLabel,
    formatHistoryListMessage,
    HISTORY_ITEM_NOT_FOUND_MESSAGE,
    HISTORY_PAGE_SIZE,
    paginateHistory,
    resolveHistoryDetailHtml,
    truncateText
} from "../src/services/telegramHistoryFormatting.ts";
import type { QueryHistoryEntry } from "../src/services/queryHistoryService.ts";

function makeEntry(id: number, overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry {
    return {
        id,
        question: `pergunta ${id}`,
        answer: `resposta ${id}`,
        sources: [],
        channel: "site",
        createdAt: new Date(`2024-01-0${(id % 9) + 1}T12:00:00Z`),
        ...overrides
    };
}

test("pagina 5 por página a partir do offset", () => {
    const entries = Array.from({ length: 12 }, (_, index) => makeEntry(index + 1));
    const page = paginateHistory(entries, 0);

    assert.equal(page.items.length, HISTORY_PAGE_SIZE);
    assert.deepEqual(page.items.map((entry) => entry.id), [1, 2, 3, 4, 5]);
    assert.equal(page.hasPrevious, false);
    assert.equal(page.hasNext, true);
});

test("segunda página usa o offset e ainda tem próxima página", () => {
    const entries = Array.from({ length: 12 }, (_, index) => makeEntry(index + 1));
    const page = paginateHistory(entries, HISTORY_PAGE_SIZE);

    assert.deepEqual(page.items.map((entry) => entry.id), [6, 7, 8, 9, 10]);
    assert.equal(page.hasPrevious, true);
    assert.equal(page.hasNext, true);
});

test("última página pode ter menos de 5 itens e não tem próxima página", () => {
    const entries = Array.from({ length: 12 }, (_, index) => makeEntry(index + 1));
    const page = paginateHistory(entries, 10);

    assert.deepEqual(page.items.map((entry) => entry.id), [11, 12]);
    assert.equal(page.hasPrevious, true);
    assert.equal(page.hasNext, false);
});

test("lista vazia na primeira página gera mensagem amigável de histórico vazio", () => {
    const page = paginateHistory([], 0);
    assert.equal(page.items.length, 0);
    assert.match(formatHistoryListMessage(page), /ainda não tem consultas/);
});

test("offset além do fim também produz lista vazia, com mensagem distinta", () => {
    const entries = [makeEntry(1)];
    const page = paginateHistory(entries, 50);

    assert.equal(page.items.length, 0);
    assert.match(formatHistoryListMessage(page), /Não há mais consultas/);
});

test("formatHistoryListMessage nunca tem 3+ quebras de linha seguidas nem começa/termina com quebra de linha", () => {
    const entries = Array.from({ length: 7 }, (_, index) => makeEntry(index + 1));
    const pages = [
        paginateHistory(entries, 0), // primeira página (5 itens, tem "Ver mais")
        paginateHistory(entries, HISTORY_PAGE_SIZE), // segunda página (2 itens, tem "Anterior")
        paginateHistory([], 0) // lista vazia
    ];

    for (const page of pages) {
        const message = formatHistoryListMessage(page);
        assert.doesNotMatch(message, /\n{3,}/, `página com offset ${page.offset} tem linhas em branco extras`);
        assert.doesNotMatch(message, /^\n/);
        assert.doesNotMatch(message, /\n$/);
    }
});

test("truncateText corta em 40 caracteres sem quebrar um caractere multi-byte", () => {
    const withEmoji = `${"a".repeat(39)}🙂resto`;
    const truncated = truncateText(withEmoji, 40);

    // 39 "a" + o emoji (um único ponto de código) = 40, então o emoji inteiro deve sobreviver.
    assert.equal(truncated, `${"a".repeat(39)}🙂…`);
    assert.doesNotMatch(truncated, /�/);
});

test("truncateText não altera texto menor que o limite", () => {
    assert.equal(truncateText("pergunta curta", 40), "pergunta curta");
});

test("formatChannelLabel mapeia site/telegram e qualquer outro valor cai em Site", () => {
    assert.equal(formatChannelLabel("telegram"), "Telegram");
    assert.equal(formatChannelLabel("site"), "Site");
    assert.equal(formatChannelLabel("outro"), "Site");
});

test("resolveHistoryDetailHtml com entrada nula (não existe ou é de outra conta) usa a mensagem genérica", () => {
    assert.equal(resolveHistoryDetailHtml(null), HISTORY_ITEM_NOT_FOUND_MESSAGE);
});

test("resolveHistoryDetailHtml com entrada válida monta pergunta, resposta e fontes em HTML", () => {
    const entry = makeEntry(1, { question: "Posso tomar <b>dipirona</b>?", sources: ["Bula A", "Bula B"] });
    const html = resolveHistoryDetailHtml(entry);

    assert.match(html, /<b>Pergunta:<\/b>/);
    assert.match(html, /&lt;b&gt;dipirona&lt;\/b&gt;/);
    assert.match(html, /Fontes: Bula A, Bula B/);
});

test("buildHistoryDetailHtml omite a linha de fontes quando não há nenhuma", () => {
    const html = buildHistoryDetailHtml(makeEntry(1, { sources: [] }));
    assert.doesNotMatch(html, /Fontes:/);
});
