import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { getDatabasePool } = await import("../src/database/database.ts");
const {
    isReminderChannel,
    REMINDER_CHANNELS,
    replaceReminderChannels,
    TelegramChannelRequiresLinkError,
    validateChannelsForUser
} = await import("../src/services/reminderChannelService.ts");

const pool = getDatabasePool();

test.afterEach(() => {
    mock.restoreAll();
});

test("REMINDER_CHANNELS contém exatamente browser e telegram", () => {
    assert.deepEqual([...REMINDER_CHANNELS].sort(), ["browser", "telegram"]);
});

test("isReminderChannel aceita só os valores válidos", () => {
    assert.equal(isReminderChannel("browser"), true);
    assert.equal(isReminderChannel("telegram"), true);
    assert.equal(isReminderChannel("sms"), false);
    assert.equal(isReminderChannel("email"), false);
    assert.equal(isReminderChannel(123), false);
    assert.equal(isReminderChannel(null), false);
});

function mockTelegramChatId(chatId: number | null) {
    mock.method(pool, "query", async () => ({
        rows: [{ telegram_chat_id: chatId === null ? null : String(chatId) }],
        rowCount: 1
    }));
}

test("validateChannelsForUser aceita ['browser'] sem consultar vínculo nenhum", async () => {
    const queryMock = mock.method(pool, "query", async () => {
        throw new Error("não deveria consultar o banco para canais sem telegram");
    });
    const result = await validateChannelsForUser(1, ["browser"]);
    assert.deepEqual(result, ["browser"]);
    assert.equal(queryMock.mock.callCount(), 0);
});

test("validateChannelsForUser rejeita 'telegram' sem vínculo (TelegramChannelRequiresLinkError, mensagem em português)", async () => {
    mockTelegramChatId(null);
    await assert.rejects(
        validateChannelsForUser(1, ["telegram"]),
        (error: unknown) => {
            assert.ok(error instanceof TelegramChannelRequiresLinkError);
            assert.match((error as Error).message, /Telegram/);
            return true;
        }
    );
});

test("validateChannelsForUser aceita 'telegram' quando há vínculo", async () => {
    mockTelegramChatId(999);
    const result = await validateChannelsForUser(1, ["telegram"]);
    assert.deepEqual(result, ["telegram"]);
});

test("validateChannelsForUser deduplica e ordena", async () => {
    mockTelegramChatId(999);
    const result = await validateChannelsForUser(1, ["telegram", "browser", "telegram"]);
    assert.deepEqual(result, ["browser", "telegram"]);
});

test("replaceReminderChannels apaga os canais anteriores e insere os novos, nessa ordem", async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const fakeClient = {
        query: async (text: string, params: unknown[] = []) => {
            calls.push({ text: text.trim(), params });
            return { rows: [], rowCount: 0 };
        }
    };

    await replaceReminderChannels(fakeClient, 42, ["browser", "telegram"]);

    assert.equal(calls.length, 3);
    assert.match(calls[0].text, /^DELETE FROM reminder_channels/);
    assert.deepEqual(calls[0].params, [42]);
    assert.match(calls[1].text, /^INSERT INTO reminder_channels/);
    assert.deepEqual(calls[1].params, [42, "browser"]);
    assert.deepEqual(calls[2].params, [42, "telegram"]);
});
