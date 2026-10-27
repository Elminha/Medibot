import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.VECTOR_STORE_ID ||= "vs_test";

const { startTypingIndicator, stopTypingIndicator, TYPING_INDICATOR_INTERVAL_MS } =
    await import("../src/services/telegramBot.ts");

test.afterEach(() => {
    mock.reset();
    mock.timers.reset();
});

test("startTypingIndicator dispara a ação imediatamente e renova a cada intervalo, sem acumular após stop", () => {
    mock.timers.enable({ apis: ["setInterval"] });

    const calls: string[] = [];
    const fakeCtx = {
        replyWithChatAction: async (action: string) => {
            calls.push(action);
        }
    } as unknown as Parameters<typeof startTypingIndicator>[0];

    const timer = startTypingIndicator(fakeCtx);

    // Chamada imediata, antes de qualquer timer disparar.
    assert.deepEqual(calls, ["typing"]);

    mock.timers.tick(TYPING_INDICATOR_INTERVAL_MS);
    assert.deepEqual(calls, ["typing", "typing"]);

    mock.timers.tick(TYPING_INDICATOR_INTERVAL_MS);
    assert.deepEqual(calls, ["typing", "typing", "typing"]);

    stopTypingIndicator(timer);

    // Depois de parado, nenhuma renovação adicional deve ocorrer.
    mock.timers.tick(TYPING_INDICATOR_INTERVAL_MS * 3);
    assert.deepEqual(calls, ["typing", "typing", "typing"]);
});
