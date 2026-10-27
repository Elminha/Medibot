import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.VECTOR_STORE_ID ||= "vs_test";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { getOpenAiTimeoutMs } = await import("../src/config.ts");
const { getWebhookTimeoutMs } = await import("../src/routes/telegramRoutes.ts");

function withEnvVar(name: string, value: string | undefined, run: () => void): void {
    const original = process.env[name];
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
    try {
        run();
    } finally {
        if (original === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = original;
        }
    }
}

test("getOpenAiTimeoutMs usa 35000ms por padrão", () => {
    withEnvVar("OPENAI_TIMEOUT_MS", undefined, () => {
        assert.equal(getOpenAiTimeoutMs(), 35_000);
    });
});

test("getOpenAiTimeoutMs respeita um override numérico válido", () => {
    withEnvVar("OPENAI_TIMEOUT_MS", "20000", () => {
        assert.equal(getOpenAiTimeoutMs(), 20_000);
    });
});

test("getOpenAiTimeoutMs ignora valores inválidos e volta ao padrão", () => {
    withEnvVar("OPENAI_TIMEOUT_MS", "nao-e-numero", () => {
        assert.equal(getOpenAiTimeoutMs(), 35_000);
    });
    withEnvVar("OPENAI_TIMEOUT_MS", "0", () => {
        assert.equal(getOpenAiTimeoutMs(), 35_000);
    });
});

test("getWebhookTimeoutMs usa 45000ms por padrão", () => {
    withEnvVar("TELEGRAM_WEBHOOK_TIMEOUT_MS", undefined, () => {
        assert.equal(getWebhookTimeoutMs(), 45_000);
    });
});

test("getWebhookTimeoutMs respeita um override numérico válido", () => {
    withEnvVar("TELEGRAM_WEBHOOK_TIMEOUT_MS", "60000", () => {
        assert.equal(getWebhookTimeoutMs(), 60_000);
    });
});

test("getWebhookTimeoutMs ignora valores inválidos e volta ao padrão", () => {
    withEnvVar("TELEGRAM_WEBHOOK_TIMEOUT_MS", "-5", () => {
        assert.equal(getWebhookTimeoutMs(), 45_000);
    });
});
