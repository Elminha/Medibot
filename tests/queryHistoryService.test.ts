import test from "node:test";
import assert from "node:assert/strict";
import {
    CONVERSATION_HISTORY_LIMIT,
    CONVERSATION_HISTORY_WINDOW_MINUTES,
    selectRecentConversationTurns,
    type QueryHistoryEntry
} from "../src/services/queryHistoryService.ts";

function makeEntry(id: number, minutesAgo: number, now: Date): QueryHistoryEntry {
    return {
        id,
        question: `pergunta ${id}`,
        answer: `resposta ${id}`,
        sources: [`fonte-${id}`],
        createdAt: new Date(now.getTime() - minutesAgo * 60_000)
    };
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
