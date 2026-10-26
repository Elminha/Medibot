import test from "node:test";
import assert from "node:assert/strict";

// telegramBot.ts importa bulaService.ts, que importa config.ts — e config.ts lança erro se
// OPENAI_API_KEY/VECTOR_STORE_ID não estiverem definidas (mesmo sem nunca chamar a API de
// verdade aqui). Definimos valores fictícios ANTES do import dinâmico, no mesmo padrão de
// tests/bulaService.test.ts, para não depender de segredos reais nem de rede.
process.env.OPENAI_API_KEY ||= "test-key";
process.env.VECTOR_STORE_ID ||= "vs_test";

const { buildLinkSuccessMessage } = await import("../src/services/telegramBot.ts");

test("sem consultas anteriores, a mensagem de vínculo fica como está (sem aviso)", () => {
    const message = buildLinkSuccessMessage(0);
    assert.doesNotMatch(message, /consulta/i);
    assert.match(message, /Conta vinculada com sucesso/);
});

test("com uma consulta anterior, usa o singular", () => {
    const message = buildLinkSuccessMessage(1);
    assert.match(message, /Você tem 1 consulta anterior\. Use \/historico para ver\./);
});

test("com mais de uma consulta anterior, usa o plural", () => {
    const message = buildLinkSuccessMessage(7);
    assert.match(message, /Você tem 7 consultas anteriores\. Use \/historico para ver\./);
});
