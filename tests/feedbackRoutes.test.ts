import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { getDatabasePool } = await import("../src/database/database.ts");
const feedbackRoutes = (await import("../src/routes/feedbackRoutes.ts")).default;

const pool = getDatabasePool();

function tokenFor(userId: number): string {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET as string, { expiresIn: "7d" });
}

interface FakeFeedbackRow {
    user_id: number;
    created_at: Date;
}

function setupDb({ insertShouldThrow = false }: { insertShouldThrow?: boolean } = {}) {
    const users = [{ id: 10, timezone: "America/Sao_Paulo" }];
    const feedbackRows: FakeFeedbackRow[] = [];

    async function handle(text: string, params: unknown[] = []) {
        const sql = text.trim();

        if (sql.includes("FROM users")) {
            const [id] = params as [number];
            const user = users.find((u) => u.id === id);
            return user
                ? {
                    rows: [{
                        id: String(user.id), name: "Usuário Teste", email: "teste@exemplo.com", phone: null,
                        timezone: user.timezone, password_hash: "hash", telegram_chat_id: null, password_changed_at: null
                    }],
                    rowCount: 1
                }
                : { rows: [], rowCount: 0 };
        }

        if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT") || sql.startsWith("ROLLBACK")) {
            return { rows: [], rowCount: 0 };
        }

        if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
            return { rows: [], rowCount: 0 };
        }

        if (sql.startsWith("SELECT COUNT(*) AS count FROM feedback")) {
            const [userId, since] = params as [number, Date];
            const count = feedbackRows.filter((row) => row.user_id === userId && row.created_at >= since).length;
            return { rows: [{ count: String(count) }], rowCount: 1 };
        }

        if (sql.startsWith("INSERT INTO feedback")) {
            if (insertShouldThrow) {
                throw new Error("falha simulada de inserção");
            }
            const [userId] = params as [number];
            feedbackRows.push({ user_id: userId, created_at: new Date() });
            return { rows: [], rowCount: 1 };
        }

        throw new Error(`fakeQuery não sabe lidar com: ${sql}`);
    }

    mock.method(pool, "query", async (sqlText: string, params?: unknown[]) => handle(sqlText, params));
    mock.method(pool, "connect", async () => ({
        query: async (sqlText: string, params?: unknown[]) => handle(sqlText, params),
        release: () => {}
    }));

    return { feedbackRows };
}

const app = express();
app.disable("etag");
app.use(express.json());
app.use("/api/feedback", feedbackRoutes);

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
    server.close();
});

test.afterEach(() => {
    mock.restoreAll();
});

const validBody = {
    type: "bug",
    rating: 4,
    message: "Encontrei um problema ao abrir os lembretes.",
    view: "lembretes",
    device: "mobile",
    contactOk: true
};

function postFeedback(body: unknown, token = tokenFor(10)) {
    return fetch(`${baseUrl}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
    });
}

test("sem token: 401", async () => {
    setupDb();
    const response = await fetch(`${baseUrl}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody)
    });
    assert.equal(response.status, 401);
});

test("POST válido devolve 201 { ok: true }", async () => {
    setupDb();
    const response = await postFeedback(validBody);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
});

test("POST aceita sem rating (nota é opcional)", async () => {
    setupDb();
    const { rating, ...withoutRating } = validBody;
    const response = await postFeedback(withoutRating);
    assert.equal(response.status, 201);
});

test("POST recusa tipo inválido com 400", async () => {
    setupDb();
    const response = await postFeedback({ ...validBody, type: "spam" });
    assert.equal(response.status, 400);
});

test("POST recusa rating fora de 1-5 com 400", async () => {
    setupDb();
    assert.equal((await postFeedback({ ...validBody, rating: 0 })).status, 400);
    assert.equal((await postFeedback({ ...validBody, rating: 6 })).status, 400);
});

test("POST recusa mensagem vazia e mensagem acima de 2000 caracteres com 400", async () => {
    setupDb();
    assert.equal((await postFeedback({ ...validBody, message: "   " })).status, 400);
    assert.equal((await postFeedback({ ...validBody, message: "a".repeat(2001) })).status, 400);
});

test("POST recusa view ou device fora da lista permitida com 400", async () => {
    setupDb();
    assert.equal((await postFeedback({ ...validBody, view: "pagina-secreta" })).status, 400);
    assert.equal((await postFeedback({ ...validBody, device: "tablet" })).status, 400);
});

test("POST aplica limite de 5 por hora: a 6ª tentativa na mesma hora recebe 429", async () => {
    setupDb();
    for (let i = 0; i < 5; i += 1) {
        assert.equal((await postFeedback(validBody)).status, 201);
    }
    const sixth = await postFeedback(validBody);
    assert.equal(sixth.status, 429);
    const data = await sixth.json();
    assert.match(data.error, /limite/i);
});

test("mensagem enviada nunca aparece em log nem na resposta de erro (inclusive em falha inesperada)", async () => {
    setupDb({ insertShouldThrow: true });
    const consoleErrorCalls: unknown[][] = [];
    mock.method(console, "error", (...args: unknown[]) => { consoleErrorCalls.push(args); });

    const secretMessage = "SEGREDO-MUITO-ESPECIFICO-" + Math.random().toString(36).slice(2);
    const response = await postFeedback({ ...validBody, message: secretMessage });

    assert.equal(response.status, 500);
    const body = await response.json();
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secretMessage));
    for (const call of consoleErrorCalls) {
        assert.doesNotMatch(JSON.stringify(call), new RegExp(secretMessage));
    }
});
