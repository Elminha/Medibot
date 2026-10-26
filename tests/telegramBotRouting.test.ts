import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// Este teste monta um Bot do grammY de verdade e roda updates completos por
// `bot.handleUpdate`, para pegar regressões de ORDEM de registro dos handlers
// (o bug original: "message:text" registrado antes de "/historico"/"/apagar"
// engolia os comandos). Só dois limites são simulados: a API do Telegram (via
// `client.fetch`, sem nenhuma chamada de rede real) e o banco (mockando
// `pool.query`, nunca conectando de verdade). Tudo o resto — roteamento do
// grammY, filtros de comando, os handlers reais do bot — roda sem mock.
//
// Também define OPENAI_API_KEY/VECTOR_STORE_ID fictícios e força um
// DATABASE_URL fictício ANTES de qualquer import, no mesmo padrão de
// tests/bulaService.test.ts e tests/telegramBot.test.ts, para não depender de
// segredos reais nem de rede/banco de verdade.
process.env.OPENAI_API_KEY ||= "test-key";
process.env.VECTOR_STORE_ID ||= "vs_test";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { Bot } = await import("grammy");
const { openai } = await import("../src/config.ts");
const { getDatabasePool } = await import("../src/database/database.ts");
const { registerHandlers } = await import("../src/services/telegramBot.ts");
const {
    buildDeleteConfirmCallbackData,
    buildHistoryOpenCallbackData,
    buildHistoryPageCallbackData,
    currentMinutesSinceEpoch,
    DELETE_CANCEL_CALLBACK_DATA
} = await import("../src/services/telegramHistoryCallback.ts");

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

const TEST_CHAT_ID = 555;
const TEST_USER_ID = 42;

const pool = getDatabasePool();

test.afterEach(() => {
    mock.restoreAll();
});

interface FakeQueryRow {
    id: string;
    user_id: number;
    question: string;
    answer: string;
    sources: string[];
    channel: "site" | "telegram";
    created_at: Date;
}

function seedRows(): FakeQueryRow[] {
    return [
        {
            id: "1",
            user_id: TEST_USER_ID,
            question: "Posso tomar dipirona em jejum?",
            answer: "Resposta de teste 1.",
            sources: [],
            channel: "site",
            created_at: new Date("2024-01-01T10:00:00Z")
        },
        {
            id: "2",
            user_id: TEST_USER_ID,
            question: "Quais os efeitos adversos da dipirona?",
            answer: "Resposta de teste 2.",
            sources: [],
            channel: "telegram",
            created_at: new Date("2024-01-02T10:00:00Z")
        }
    ];
}

interface ApiCall {
    method: string;
    payload: Record<string, unknown>;
}

function setup() {
    const apiCalls: ApiCall[] = [];
    const insertCalls: Array<{ params: unknown[] }> = [];
    const deleteCalls: Array<{ params: unknown[] }> = [];
    let queryRows = seedRows();

    async function fakeFetch(url: string, init?: { body?: unknown }) {
        const method = new URL(String(url)).pathname.split("/").pop() ?? "";
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        apiCalls.push({ method, payload });
        return { json: async () => ({ ok: true, result: true }) } as Response;
    }

    async function fakeQuery(text: string, params: unknown[] = []) {
        const sql = text.trim();

        if (sql.includes("telegram_processed_updates")) {
            return { rows: [{ update_id: params[0] }], rowCount: 1 };
        }

        if (sql.includes("FROM users WHERE telegram_chat_id")) {
            const chatId = params[0];
            return chatId === TEST_CHAT_ID
                ? { rows: [{ id: String(TEST_USER_ID) }], rowCount: 1 }
                : { rows: [], rowCount: 0 };
        }

        if (sql.startsWith("DELETE FROM queries")) {
            const [userId] = params as [number];
            const before = queryRows.length;
            queryRows = queryRows.filter((row) => !(row.user_id === userId && row.channel === "telegram"));
            deleteCalls.push({ params });
            return { rows: [], rowCount: before - queryRows.length };
        }

        if (sql.startsWith("INSERT INTO queries")) {
            insertCalls.push({ params });
            const [userId, question, answer, sourcesJson, channel] = params as [number, string, string, string, string];
            const row: FakeQueryRow = {
                id: String(1000 + queryRows.length + 1),
                user_id: userId,
                question,
                answer,
                sources: JSON.parse(sourcesJson),
                channel: channel === "telegram" ? "telegram" : "site",
                created_at: new Date()
            };
            queryRows.push(row);
            return { rows: [row], rowCount: 1 };
        }

        if (sql.includes("SELECT COUNT(*)")) {
            const [userId] = params as [number];
            if (sql.includes("channel = 'telegram'")) {
                const count = queryRows.filter((row) => row.user_id === userId && row.channel === "telegram").length;
                return { rows: [{ count: String(count) }], rowCount: 1 };
            }
            // countQueriesSince / countQueries: sempre devolve 0 para nunca acionar o limite por hora no teste.
            return { rows: [{ count: "0" }], rowCount: 1 };
        }

        if (sql.includes("WHERE id = $1 AND user_id = $2")) {
            const [id, userId] = params as [number, number];
            const row = queryRows.find((candidate) => candidate.id === String(id) && candidate.user_id === userId);
            return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        if (sql.includes("FROM queries")) {
            // listQueries OU getRecentConversationTurns: ambas filtram só por user_id aqui.
            const [userId] = params as [number];
            const rows = queryRows.filter((row) => row.user_id === userId);
            return { rows, rowCount: rows.length };
        }

        return { rows: [], rowCount: 0 };
    }

    mock.method(pool, "query", fakeQuery);

    const bot = new Bot(FAKE_TOKEN, {
        botInfo: FAKE_BOT_INFO,
        client: { fetch: fakeFetch as unknown as typeof fetch }
    });
    registerHandlers(bot);

    return { bot, apiCalls, insertCalls, deleteCalls, getQueryRows: () => queryRows };
}

let nextUpdateId = 1;

function commandEntities(text: string) {
    const match = text.match(/^\/\S+/);
    return match ? [{ offset: 0, length: match[0].length, type: "bot_command" as const }] : undefined;
}

function textUpdate(text: string, chatId: number = TEST_CHAT_ID) {
    nextUpdateId += 1;
    return {
        update_id: nextUpdateId,
        message: {
            message_id: nextUpdateId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private" as const },
            from: { id: chatId, is_bot: false, first_name: "Teste" },
            text,
            entities: commandEntities(text)
        }
    };
}

function callbackQueryUpdate(data: string, chatId: number = TEST_CHAT_ID) {
    nextUpdateId += 1;
    return {
        update_id: nextUpdateId,
        callback_query: {
            id: String(nextUpdateId),
            from: { id: chatId, is_bot: false, first_name: "Teste" },
            chat_instance: "fake-chat-instance",
            message: {
                message_id: 1,
                date: Math.floor(Date.now() / 1000),
                chat: { id: chatId, type: "private" as const }
            },
            data
        }
    };
}

function mockOpenAiOnce(response: unknown) {
    return mock.method(openai.responses, "create", async () => response as never);
}

function sendMessageCalls(apiCalls: ApiCall[]) {
    return apiCalls.filter((call) => call.method === "sendMessage");
}

test("/historico aciona a lista paginada, não a OpenAI nem saveQuery", async () => {
    const { bot, apiCalls, insertCalls } = setup();
    const createMock = mockOpenAiOnce({ output_text: "não deveria ser chamado", output: [] });

    await bot.handleUpdate(textUpdate("/historico") as never);

    const replies = sendMessageCalls(apiCalls);
    assert.equal(replies.length, 1);
    assert.match(String(replies[0].payload.text), /Suas consultas mais recentes/);
    assert.ok(Array.isArray((replies[0].payload.reply_markup as Record<string, unknown>)?.inline_keyboard));
    assert.equal(createMock.mock.callCount(), 0);
    assert.equal(insertCalls.length, 0);
});

test("/apagar mostra a confirmação com a contagem certa, não a OpenAI nem saveQuery", async () => {
    const { bot, apiCalls, insertCalls } = setup();
    const createMock = mockOpenAiOnce({ output_text: "não deveria ser chamado", output: [] });

    await bot.handleUpdate(textUpdate("/apagar") as never);

    const replies = sendMessageCalls(apiCalls);
    assert.equal(replies.length, 1);
    assert.match(String(replies[0].payload.text), /Isso vai apagar 1 consulta feita por aqui pelo Telegram/);
    const keyboard = (replies[0].payload.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard;
    assert.deepEqual(keyboard.flat().map((button) => button.text), ["Sim, apagar", "Cancelar"]);
    assert.equal(createMock.mock.callCount(), 0);
    assert.equal(insertCalls.length, 0);
});

test("/ajuda continua funcionando (registrado antes de message:text) e lista /historico e /apagar", async () => {
    const { bot, apiCalls } = setup();

    await bot.handleUpdate(textUpdate("/ajuda") as never);

    const replies = sendMessageCalls(apiCalls);
    assert.equal(replies.length, 1);
    assert.match(String(replies[0].payload.text), /\/historico/);
    assert.match(String(replies[0].payload.text), /\/apagar/);
});

test("/start sem código continua respondendo as boas-vindas", async () => {
    const { bot, apiCalls } = setup();

    await bot.handleUpdate(textUpdate("/start") as never);

    const replies = sendMessageCalls(apiCalls);
    assert.equal(replies.length, 1);
    assert.match(String(replies[0].payload.text), /Olá! Eu sou o MediBot\./);
});

test("comando desconhecido recebe a mensagem padrão, sem OpenAI e sem saveQuery", async () => {
    const { bot, apiCalls, insertCalls } = setup();
    const createMock = mockOpenAiOnce({ output_text: "não deveria ser chamado", output: [] });

    await bot.handleUpdate(textUpdate("/blah") as never);

    const replies = sendMessageCalls(apiCalls);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].payload.text, "Não conheci esse comando. Use /ajuda para ver os comandos disponíveis.");
    assert.equal(createMock.mock.callCount(), 0);
    assert.equal(insertCalls.length, 0);
});

test("/historico@medibot_test_bot (forma com @nomedobot) também aciona a lista, não o texto livre", async () => {
    const { bot, apiCalls, insertCalls } = setup();
    const createMock = mockOpenAiOnce({ output_text: "não deveria ser chamado", output: [] });

    await bot.handleUpdate(textUpdate("/historico@medibot_test_bot") as never);

    const replies = sendMessageCalls(apiCalls);
    assert.equal(replies.length, 1);
    assert.match(String(replies[0].payload.text), /Suas consultas mais recentes/);
    assert.equal(createMock.mock.callCount(), 0);
    assert.equal(insertCalls.length, 0);
});

test("texto livre (pergunta de verdade) chama a OpenAI e salva via saveQuery", async () => {
    const { bot, apiCalls, insertCalls } = setup();
    const createMock = mockOpenAiOnce({
        output_text: "Resposta de teste.",
        output: [{ type: "message", content: [{ type: "output_text", text: "Resposta de teste.", annotations: [] }] }]
    });

    await bot.handleUpdate(textUpdate("Quais os efeitos da dipirona?") as never);

    assert.equal(createMock.mock.callCount(), 1);
    assert.equal(insertCalls.length, 1);
    assert.equal(insertCalls[0].params[4], "telegram");
    const replies = sendMessageCalls(apiCalls);
    assert.ok(replies.some((call) => String(call.payload.text).includes("Resposta de teste.")));
});

test("callback_query h:p: (página da lista) responde o callback e reenvia a lista, sem OpenAI/saveQuery", async () => {
    const { bot, apiCalls, insertCalls } = setup();
    const createMock = mockOpenAiOnce({ output_text: "não deveria ser chamado", output: [] });

    await bot.handleUpdate(callbackQueryUpdate(buildHistoryPageCallbackData(0)) as never);

    assert.ok(apiCalls.some((call) => call.method === "answerCallbackQuery"));
    const replies = sendMessageCalls(apiCalls);
    assert.ok(replies.some((call) => String(call.payload.text).includes("Suas consultas mais recentes")));
    assert.equal(createMock.mock.callCount(), 0);
    assert.equal(insertCalls.length, 0);
});

test("callback_query h:o: (abrir item) responde o callback e mostra o detalhe, sem OpenAI/saveQuery", async () => {
    const { bot, apiCalls, insertCalls } = setup();
    const createMock = mockOpenAiOnce({ output_text: "não deveria ser chamado", output: [] });

    await bot.handleUpdate(callbackQueryUpdate(buildHistoryOpenCallbackData(1, 0)) as never);

    assert.ok(apiCalls.some((call) => call.method === "answerCallbackQuery"));
    const replies = sendMessageCalls(apiCalls);
    assert.ok(replies.some((call) => String(call.payload.text).includes("Pergunta:")));
    const withKeyboard = replies.find((call) => call.payload.reply_markup);
    assert.ok(withKeyboard);
    const keyboard = (withKeyboard!.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard;
    assert.ok(keyboard.flat().some((button) => button.text.includes("Voltar à lista")));
    assert.equal(createMock.mock.callCount(), 0);
    assert.equal(insertCalls.length, 0);
});

test("callback_query a:y: (confirmar /apagar, não expirado) apaga só o canal telegram e edita a mensagem", async () => {
    const { bot, apiCalls, deleteCalls, getQueryRows } = setup();

    await bot.handleUpdate(callbackQueryUpdate(buildDeleteConfirmCallbackData(currentMinutesSinceEpoch())) as never);

    assert.ok(apiCalls.some((call) => call.method === "answerCallbackQuery"));
    const edits = apiCalls.filter((call) => call.method === "editMessageText");
    assert.equal(edits.length, 1);
    assert.match(String(edits[0].payload.text), /1 consulta feita pelo Telegram foi apagada/);
    assert.equal(deleteCalls.length, 1);
    assert.ok(getQueryRows().every((row) => row.channel !== "telegram"));
    assert.ok(getQueryRows().some((row) => row.channel === "site"));
});

test("callback_query a:y: expirado (mais de 5 minutos) não apaga nada", async () => {
    const { bot, apiCalls, deleteCalls, getQueryRows } = setup();
    const expiredMinutes = currentMinutesSinceEpoch() - 6;

    await bot.handleUpdate(callbackQueryUpdate(buildDeleteConfirmCallbackData(expiredMinutes)) as never);

    const callbackAnswers = apiCalls.filter((call) => call.method === "answerCallbackQuery");
    assert.equal(callbackAnswers.length, 1);
    assert.match(String(callbackAnswers[0].payload.text), /confirmação expirou/);
    assert.equal(deleteCalls.length, 0);
    assert.ok(getQueryRows().some((row) => row.channel === "telegram"));
});

test("callback_query a:n (cancelar) não apaga nada e edita a mensagem para 'cancelado'", async () => {
    const { bot, apiCalls, deleteCalls } = setup();

    await bot.handleUpdate(callbackQueryUpdate(DELETE_CANCEL_CALLBACK_DATA) as never);

    assert.ok(apiCalls.some((call) => call.method === "answerCallbackQuery"));
    const edits = apiCalls.filter((call) => call.method === "editMessageText");
    assert.equal(edits.length, 1);
    assert.match(String(edits[0].payload.text), /cancelado/);
    assert.equal(deleteCalls.length, 0);
});
