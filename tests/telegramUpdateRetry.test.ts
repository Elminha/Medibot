import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// Mesmo padrão de tests/telegramBotRouting.test.ts: valores fictícios ANTES de qualquer
// import, bot real do grammY rodando bot.handleUpdate, só a API do Telegram (fetch) e o
// banco (pool.query) são mockados.
process.env.OPENAI_API_KEY ||= "test-key";
process.env.VECTOR_STORE_ID ||= "vs_test";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { Bot } = await import("grammy");
const { openai } = await import("../src/config.ts");
const { getDatabasePool } = await import("../src/database/database.ts");
const { registerHandlers, PROCESSING_ERROR_MESSAGE } = await import("../src/services/telegramBot.ts");
const { PROCESSING_DEAD_AFTER_MS } = await import("../src/services/telegramUpdateLog.ts");

const FAKE_TOKEN = "111111:TEST-TOKEN-NOT-REAL";
const FAKE_BOT_INFO = {
    id: 111111,
    is_bot: true as const,
    first_name: "MediBot Teste",
    username: "medibot_test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false
};

const TEST_CHAT_ID = 777;
const TEST_USER_ID = 99;

const pool = getDatabasePool();

test.afterEach(() => {
    mock.restoreAll();
});

interface ApiCall {
    method: string;
    payload: Record<string, unknown>;
}

interface UpdateRow {
    chatId: number;
    status: "processing" | "done";
    startedAt: number;
}

function setup() {
    const apiCalls: ApiCall[] = [];
    const insertCalls: Array<{ params: unknown[] }> = [];
    const updateRows = new Map<number, UpdateRow>();

    async function fakeFetch(url: string, init?: { body?: unknown }) {
        const method = new URL(String(url)).pathname.split("/").pop() ?? "";
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        apiCalls.push({ method, payload });
        return { json: async () => ({ ok: true, result: true }) } as Response;
    }

    // Reproduz, em memória, a mesma semântica das três queries de
    // src/services/telegramUpdateLog.ts (claim atômico / done / release), sem precisar
    // de um Postgres de verdade.
    async function fakeQuery(text: string, params: unknown[] = []) {
        const sql = text.trim();

        if (sql.startsWith("INSERT INTO telegram_processed_updates")) {
            const [updateId, chatId, deadAfterMs] = params as [number, number, number];
            const now = Date.now();
            const existing = updateRows.get(updateId);

            if (!existing) {
                updateRows.set(updateId, { chatId, status: "processing", startedAt: now });
                return { rows: [{ update_id: updateId }], rowCount: 1 };
            }

            const isDead = existing.status === "processing" && now - existing.startedAt >= deadAfterMs;
            if (isDead) {
                existing.startedAt = now;
                existing.chatId = chatId;
                return { rows: [{ update_id: updateId }], rowCount: 1 };
            }

            return { rows: [], rowCount: 0 };
        }

        if (sql.startsWith("UPDATE telegram_processed_updates")) {
            const [updateId] = params as [number];
            const existing = updateRows.get(updateId);

            if (sql.includes("'done'")) {
                if (existing) existing.status = "done";
            } else {
                const [, deadAfterMs] = params as [number, number];
                if (existing) {
                    existing.status = "processing";
                    existing.startedAt = Date.now() - deadAfterMs;
                }
            }

            return { rows: [], rowCount: existing ? 1 : 0 };
        }

        if (sql.includes("FROM users WHERE telegram_chat_id")) {
            const chatId = params[0];
            return chatId === TEST_CHAT_ID
                ? { rows: [{ id: String(TEST_USER_ID) }], rowCount: 1 }
                : { rows: [], rowCount: 0 };
        }

        if (sql.startsWith("INSERT INTO queries")) {
            insertCalls.push({ params });
            return { rows: [{ id: "1", created_at: new Date() }], rowCount: 1 };
        }

        if (sql.includes("SELECT COUNT(*)")) {
            // countQueriesSince: nunca aciona o limite por hora nestes testes.
            return { rows: [{ count: "0" }], rowCount: 1 };
        }

        if (sql.includes("FROM queries")) {
            // getRecentConversationTurns: sem histórico nestes testes.
            return { rows: [], rowCount: 0 };
        }

        return { rows: [], rowCount: 0 };
    }

    mock.method(pool, "query", fakeQuery);

    const bot = new Bot(FAKE_TOKEN, {
        botInfo: FAKE_BOT_INFO,
        client: { fetch: fakeFetch as unknown as typeof fetch }
    });
    registerHandlers(bot);

    return { bot, apiCalls, insertCalls, updateRows };
}

function textUpdate(updateId: number, text: string, chatId: number = TEST_CHAT_ID) {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private" as const },
            from: { id: chatId, is_bot: false, first_name: "Teste" },
            text
        }
    };
}

function sendMessageCalls(apiCalls: ApiCall[]) {
    return apiCalls.filter((call) => call.method === "sendMessage");
}

function mockOpenAiOnce(response: unknown) {
    return mock.method(openai.responses, "create", async () => response as never);
}

function mockOpenAiRejectOnce(error: Error) {
    return mock.method(openai.responses, "create", async () => {
        throw error;
    });
}

const SUCCESS_RESPONSE = {
    output_text: "Resposta de teste.",
    output: [{ type: "message", content: [{ type: "output_text", text: "Resposta de teste.", annotations: [] }] }]
};

test("falha seguida de reenvio do MESMO update_id é processada e respondida", async () => {
    const { bot, apiCalls, insertCalls } = setup();
    const UPDATE_ID = 5001;

    mockOpenAiRejectOnce(new Error("Request timed out after 10000 ms"));
    await bot.handleUpdate(textUpdate(UPDATE_ID, "Qual o efeito da dipirona?") as never);

    const afterFailure = sendMessageCalls(apiCalls);
    assert.equal(afterFailure.length, 1);
    assert.equal(afterFailure[0].payload.text, PROCESSING_ERROR_MESSAGE);
    assert.equal(insertCalls.length, 0);

    mockOpenAiOnce(SUCCESS_RESPONSE);
    await bot.handleUpdate(textUpdate(UPDATE_ID, "Qual o efeito da dipirona?") as never);

    const afterRetry = sendMessageCalls(apiCalls);
    assert.equal(afterRetry.length, 2);
    assert.ok(afterRetry.some((call) => String(call.payload.text).includes("Resposta de teste.")));
    assert.equal(insertCalls.length, 1);
});

test("reenvio de um update já concluído é ignorado (nenhuma segunda resposta)", async () => {
    const { bot, apiCalls, insertCalls } = setup();
    const UPDATE_ID = 5002;
    const createMock = mockOpenAiOnce(SUCCESS_RESPONSE);

    await bot.handleUpdate(textUpdate(UPDATE_ID, "Qual o efeito do ibuprofeno?") as never);
    assert.equal(createMock.mock.callCount(), 1);
    assert.equal(insertCalls.length, 1);

    const apiCallsBeforeResend = apiCalls.length;
    await bot.handleUpdate(textUpdate(UPDATE_ID, "Qual o efeito do ibuprofeno?") as never);

    assert.equal(createMock.mock.callCount(), 1);
    assert.equal(insertCalls.length, 1);
    assert.equal(apiCalls.length, apiCallsBeforeResend);
});

test("duas entregas simultâneas do mesmo update_id geram uma só resposta", async () => {
    const { bot, apiCalls, insertCalls } = setup();
    const UPDATE_ID = 5003;
    const createMock = mockOpenAiOnce(SUCCESS_RESPONSE);

    await Promise.all([
        bot.handleUpdate(textUpdate(UPDATE_ID, "Qual o efeito da amoxicilina?") as never),
        bot.handleUpdate(textUpdate(UPDATE_ID, "Qual o efeito da amoxicilina?") as never)
    ]);

    assert.equal(createMock.mock.callCount(), 1);
    assert.equal(insertCalls.length, 1);
    const answers = sendMessageCalls(apiCalls).filter((call) => String(call.payload.text).includes("Resposta de teste."));
    assert.equal(answers.length, 1);
});

test("falha tratada (timeout simulado da OpenAI) responde a mensagem amigável e não vaza detalhes", async () => {
    const { bot, apiCalls, insertCalls } = setup();
    const UPDATE_ID = 5004;
    const question = "Quais os efeitos colaterais do paracetamol?";

    mockOpenAiRejectOnce(new Error("Request timed out after 10000 ms"));
    await bot.handleUpdate(textUpdate(UPDATE_ID, question) as never);

    const replies = sendMessageCalls(apiCalls);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].payload.text, PROCESSING_ERROR_MESSAGE);
    assert.doesNotMatch(String(replies[0].payload.text), /paracetamol/i);
    assert.doesNotMatch(String(replies[0].payload.text), /timed out/i);
    assert.equal(insertCalls.length, 0);
});

test("uma tentativa 'morta' (processing há mais que o prazo) pode ser reivindicada de novo", async () => {
    const { bot, apiCalls, insertCalls, updateRows } = setup();
    const UPDATE_ID = 5005;

    // Simula uma instância anterior que começou a processar e nunca terminou (ex.: a
    // função serverless foi encerrada no meio), sem passar por releaseUpdateForRetry.
    updateRows.set(UPDATE_ID, {
        chatId: TEST_CHAT_ID,
        status: "processing",
        startedAt: Date.now() - (PROCESSING_DEAD_AFTER_MS + 1_000)
    });

    mockOpenAiOnce(SUCCESS_RESPONSE);
    await bot.handleUpdate(textUpdate(UPDATE_ID, "Qual o efeito da dipirona?") as never);

    const replies = sendMessageCalls(apiCalls);
    assert.ok(replies.some((call) => String(call.payload.text).includes("Resposta de teste.")));
    assert.equal(insertCalls.length, 1);
    assert.equal(updateRows.get(UPDATE_ID)?.status, "done");
});
