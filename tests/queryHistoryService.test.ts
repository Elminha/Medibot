import test from "node:test";
import assert from "node:assert/strict";
import {
    CONVERSATION_HISTORY_LIMIT,
    CONVERSATION_HISTORY_WINDOW_MINUTES,
    deleteQuery,
    deleteTelegramQueries,
    countTelegramQueries,
    selectRecentConversationTurns,
    type QueryExecutor,
    type QueryHistoryEntry
} from "../src/services/queryHistoryService.ts";

function makeEntry(id: number, minutesAgo: number, now: Date): QueryHistoryEntry {
    return {
        id,
        question: `pergunta ${id}`,
        answer: `resposta ${id}`,
        sources: [`fonte-${id}`],
        channel: "site",
        createdAt: new Date(now.getTime() - minutesAgo * 60_000)
    };
}

/** "Pool" falso que grava a última consulta SQL+parâmetros, para testar sem banco real. */
function makeFakeExecutor(response: { rows?: unknown[]; rowCount?: number | null }): {
    executor: QueryExecutor;
    calls: Array<{ text: string; params: unknown[] | undefined }>;
} {
    const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
    const executor: QueryExecutor = {
        async query(text: string, params?: unknown[]) {
            calls.push({ text, params });
            return { rows: response.rows ?? [], rowCount: response.rowCount ?? 0 };
        }
    };
    return { executor, calls };
}

test("mantém no máximo CONVERSATION_HISTORY_LIMIT trocas, mesmo havendo mais disponíveis na janela", () => {
    const now = new Date("2024-01-01T12:00:00Z");
    // 5 entradas recentes (todas dentro da janela), ordenadas da mais nova para a mais antiga.
    const entries = [5, 4, 3, 2, 1].map((id) => makeEntry(id, id, now));

    const turns = selectRecentConversationTurns(entries, now);

    assert.equal(turns.length, CONVERSATION_HISTORY_LIMIT);
});

test("descarta trocas fora da janela de tempo configurada", () => {
    const now = new Date("2024-01-01T12:00:00Z");
    const entries = [
        makeEntry(1, 5, now), // dentro da janela
        makeEntry(2, CONVERSATION_HISTORY_WINDOW_MINUTES + 1, now) // fora da janela (muito antiga)
    ];

    const turns = selectRecentConversationTurns(entries, now);

    assert.equal(turns.length, 1);
    assert.equal(turns[0].question, "pergunta 1");
});

test("inclui uma troca exatamente no limite da janela", () => {
    const now = new Date("2024-01-01T12:00:00Z");
    const entries = [makeEntry(1, CONVERSATION_HISTORY_WINDOW_MINUTES, now)];

    const turns = selectRecentConversationTurns(entries, now);

    assert.equal(turns.length, 1);
});

test("devolve as trocas em ordem cronológica (mais antiga primeiro)", () => {
    const now = new Date("2024-01-01T12:00:00Z");
    const entries = [makeEntry(3, 1, now), makeEntry(2, 2, now), makeEntry(1, 3, now)];

    const turns = selectRecentConversationTurns(entries, now);

    assert.deepEqual(turns.map((turn) => turn.question), ["pergunta 1", "pergunta 2", "pergunta 3"]);
});

test("aceita limite e janela customizados", () => {
    const now = new Date("2024-01-01T12:00:00Z");
    const entries = [makeEntry(4, 1, now), makeEntry(3, 2, now), makeEntry(2, 3, now), makeEntry(1, 4, now)];

    const turns = selectRecentConversationTurns(entries, now, 2, 10);

    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((turn) => turn.question), ["pergunta 3", "pergunta 4"]);
});

test("cada troca preserva pergunta, resposta e fontes, sem o id/createdAt", () => {
    const now = new Date("2024-01-01T12:00:00Z");
    const turns = selectRecentConversationTurns([makeEntry(1, 1, now)], now);

    assert.deepEqual(turns[0], { question: "pergunta 1", answer: "resposta 1", sources: ["fonte-1"] });
});

test("deleteQuery filtra por id e por user_id, e retorna false quando nada foi apagado", async () => {
    const { executor, calls } = makeFakeExecutor({ rowCount: 0 });
    const deleted = await deleteQuery(42, 7, executor);

    assert.equal(deleted, false);
    assert.match(calls[0].text, /DELETE FROM queries WHERE id = \$1 AND user_id = \$2/);
    assert.deepEqual(calls[0].params, [7, 42]);
});

test("deleteQuery retorna true quando a linha pertencia ao usuário e foi apagada", async () => {
    const { executor } = makeFakeExecutor({ rowCount: 1 });
    assert.equal(await deleteQuery(42, 7, executor), true);
});

test("deleteQuery responde igual (false) tanto para consulta inexistente quanto para consulta de outra conta", async () => {
    // Nos dois casos o banco real devolve rowCount 0 para `WHERE id = $1 AND user_id = $2`,
    // então a função não tem como (e não deve) diferenciar os dois casos.
    const naoExiste = makeFakeExecutor({ rowCount: 0 });
    const deOutraConta = makeFakeExecutor({ rowCount: 0 });

    assert.equal(await deleteQuery(1, 999, naoExiste.executor), false);
    assert.equal(await deleteQuery(2, 999, deOutraConta.executor), false);
});

test("deleteTelegramQueries só apaga linhas com channel = 'telegram' do usuário", async () => {
    const { executor, calls } = makeFakeExecutor({ rowCount: 3 });
    const deletedCount = await deleteTelegramQueries(42, executor);

    assert.equal(deletedCount, 3);
    assert.match(calls[0].text, /DELETE FROM queries WHERE user_id = \$1 AND channel = 'telegram'/);
    assert.deepEqual(calls[0].params, [42]);
});

test("deleteTelegramQueries não menciona a coluna channel = 'site' em nenhum lugar da query", async () => {
    const { executor, calls } = makeFakeExecutor({ rowCount: 0 });
    await deleteTelegramQueries(1, executor);
    assert.doesNotMatch(calls[0].text, /'site'/);
});

test("countTelegramQueries conta apenas consultas com channel = 'telegram' do usuário", async () => {
    const { executor, calls } = makeFakeExecutor({ rows: [{ count: "5" }] });
    const count = await countTelegramQueries(42, executor);

    assert.equal(count, 5);
    assert.match(calls[0].text, /WHERE user_id = \$1 AND channel = 'telegram'/);
    assert.deepEqual(calls[0].params, [42]);
});
