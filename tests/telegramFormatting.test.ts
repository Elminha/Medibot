import test from "node:test";
import assert from "node:assert/strict";
import {
    escapeTelegramHtml,
    markdownToTelegramHtml,
    splitTelegramMessage
} from "../src/services/telegramFormatting.ts";

test("escapeTelegramHtml escapa &, < e >", () => {
    assert.equal(escapeTelegramHtml("5 < 10 & 10 > 5"), "5 &lt; 10 &amp; 10 &gt; 5");
});

test("markdownToTelegramHtml converte cabeçalhos em negrito", () => {
    assert.equal(markdownToTelegramHtml("### Contraindicações"), "<b>Contraindicações</b>");
});

test("markdownToTelegramHtml converte negrito, itálico e código inline", () => {
    assert.equal(markdownToTelegramHtml("Use **sempre** com *cuidado* via `sonda`"),
        "Use <b>sempre</b> com <i>cuidado</i> via <code>sonda</code>");
});

test("markdownToTelegramHtml converte listas com - e * em marcadores •", () => {
    const result = markdownToTelegramHtml("- primeiro item\n* segundo item");
    assert.equal(result, "• primeiro item\n• segundo item");
});

test("markdownToTelegramHtml escapa conteúdo antes de inserir tags, sem permitir HTML externo", () => {
    const result = markdownToTelegramHtml("Nível <script>alert(1)</script> **importante**");
    assert.equal(result, "Nível &lt;script&gt;alert(1)&lt;/script&gt; <b>importante</b>");
});

test("splitTelegramMessage retorna uma única parte quando cabe no limite", () => {
    assert.deepEqual(splitTelegramMessage("resposta curta", 4000), ["resposta curta"]);
});

test("splitTelegramMessage retorna lista vazia para texto vazio", () => {
    assert.deepEqual(splitTelegramMessage("", 4000), []);
});

test("splitTelegramMessage divide por linhas sem exceder o limite", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `Linha ${index} com algum conteúdo de teste.`);
    const html = lines.join("\n");
    const parts = splitTelegramMessage(html, 200);

    assert.ok(parts.length > 1);
    for (const part of parts) {
        assert.ok(part.length <= 200, `parte excedeu o limite: ${part.length}`);
    }
    assert.equal(parts.join("\n"), html);
});

test("splitTelegramMessage corta por caractere uma linha única maior que o limite", () => {
    const hugeLine = "x".repeat(250);
    const parts = splitTelegramMessage(hugeLine, 100);

    assert.equal(parts.length, 3);
    assert.equal(parts.join(""), hugeLine);
    for (const part of parts) {
        assert.ok(part.length <= 100);
    }
});
