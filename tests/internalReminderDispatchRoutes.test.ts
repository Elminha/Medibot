import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.VECTOR_STORE_ID ||= "vs_test";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";
process.env.TELEGRAM_BOT_TOKEN ||= "111111:TEST-TOKEN-NOT-REAL";

const { getDatabasePool } = await import("../src/database/database.ts");
const internalReminderDispatchRoutes = (await import("../src/routes/internalReminderDispatchRoutes.ts")).default;

const pool = getDatabasePool();
const VALID_SECRET = "a".repeat(32);

// Nenhum teste aqui dispara um envio real pelo Telegram: a query de candidatos sempre
// devolve zero linhas, então runReminderDispatch nunca chama bot.api.sendMessage (sem
// acesso à internet). O envio/retentativa/idempotência de verdade já é testado, com
// injeção de dependência, em tests/reminderDispatchService.test.ts.
function setupEmptyDb() {
    mock.method(pool, "query", async (text: string) => {
        const sql = text.trim();
        if (sql.includes("INNER JOIN reminder_channels")) {
            return { rows: [], rowCount: 0 };
        }
        throw new Error(`fakeQuery não sabe lidar com: ${sql}`);
    });
}

const app = express();
app.disable("etag");
app.use(express.json());
app.use("/api/internal/reminders", internalReminderDispatchRoutes);

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
    server.close();
});

test.afterEach(() => {
    mock.restoreAll();
    delete process.env.CRON_SECRET;
});

test("CRON_SECRET ausente: 404 e nunca executa (não consulta o banco)", async () => {
    delete process.env.CRON_SECRET;
    const queryMock = mock.method(pool, "query", async () => {
        throw new Error("não deveria consultar o banco sem CRON_SECRET configurado");
    });

    const response = await fetch(`${baseUrl}/api/internal/reminders/dispatch`, {
        method: "POST",
        headers: { "x-cron-secret": VALID_SECRET }
    });

    assert.equal(response.status, 404);
    assert.equal(queryMock.mock.callCount(), 0);
});

test("CRON_SECRET curto (< 24 caracteres): 404 e nunca executa", async () => {
    process.env.CRON_SECRET = "segredo-curto-demais";
    assert.ok(process.env.CRON_SECRET.length < 24);
    const queryMock = mock.method(pool, "query", async () => {
        throw new Error("não deveria consultar o banco com CRON_SECRET curto demais");
    });

    const response = await fetch(`${baseUrl}/api/internal/reminders/dispatch`, {
        method: "POST",
        headers: { "x-cron-secret": process.env.CRON_SECRET }
    });

    assert.equal(response.status, 404);
    assert.equal(queryMock.mock.callCount(), 0);
});

test("segredo ausente no request: 401 genérico", async () => {
    process.env.CRON_SECRET = VALID_SECRET;
    setupEmptyDb();

    const response = await fetch(`${baseUrl}/api/internal/reminders/dispatch`, { method: "POST" });
    assert.equal(response.status, 401);
    const data = await response.json();
    assert.ok(data.error);
});

test("segredo errado: 401 genérico", async () => {
    process.env.CRON_SECRET = VALID_SECRET;
    setupEmptyDb();

    const response = await fetch(`${baseUrl}/api/internal/reminders/dispatch`, {
        method: "POST",
        headers: { "x-cron-secret": "b".repeat(32) }
    });
    assert.equal(response.status, 401);
});

test("segredo correto via x-cron-secret: 200 com dryRun=1 (sem CRON_SECRET real na resposta)", async () => {
    process.env.CRON_SECRET = VALID_SECRET;
    setupEmptyDb();

    const response = await fetch(`${baseUrl}/api/internal/reminders/dispatch?dryRun=1`, {
        method: "POST",
        headers: { "x-cron-secret": VALID_SECRET }
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.dryRun, true);
    assert.equal(data.candidates, 0);
    assert.equal(data.sent, 0);
    const bodyText = JSON.stringify(data);
    assert.doesNotMatch(bodyText, new RegExp(VALID_SECRET));
});

test("segredo correto via Authorization: Bearer: 200", async () => {
    process.env.CRON_SECRET = VALID_SECRET;
    setupEmptyDb();

    const response = await fetch(`${baseUrl}/api/internal/reminders/dispatch?dryRun=1`, {
        method: "POST",
        headers: { authorization: `Bearer ${VALID_SECRET}` }
    });
    assert.equal(response.status, 200);
});

test("resposta nunca inclui chat_id, nome de medicamento ou e-mail: só contagens", async () => {
    process.env.CRON_SECRET = VALID_SECRET;
    setupEmptyDb();

    const response = await fetch(`${baseUrl}/api/internal/reminders/dispatch?dryRun=1`, {
        method: "POST",
        headers: { "x-cron-secret": VALID_SECRET }
    });
    const data = await response.json();
    assert.deepEqual(Object.keys(data).sort(), [
        "candidates", "dryRun", "expiredOutsideWindow", "failed", "occurrencesInWindow", "sent", "skipped"
    ].sort());
    for (const value of Object.values(data)) {
        assert.ok(typeof value === "number" || typeof value === "boolean");
    }
});

test("execução sem dryRun (sem candidatos devidos): 200, nenhum envio, nenhuma chamada ao Telegram", async () => {
    process.env.CRON_SECRET = VALID_SECRET;
    setupEmptyDb();

    const response = await fetch(`${baseUrl}/api/internal/reminders/dispatch`, {
        method: "POST",
        headers: { "x-cron-secret": VALID_SECRET }
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.dryRun, false);
    assert.equal(data.sent, 0);
});
