import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import type { AddressInfo } from "node:net";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { getDatabasePool } = await import("../src/database/database.ts");
const accountRoutes = (await import("../src/routes/accountRoutes.ts")).default;

const pool = getDatabasePool();

function tokenFor(userId: number): string {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET as string, { expiresIn: "7d" });
}

function setupDb(passwordHash: string) {
    let userExists = true;
    const deletionAttempts: Date[] = [];
    const deleteCalls: string[] = [];

    mock.method(pool, "query", async (sql: string, params: unknown[] = []) => {
        const text = sql.trim();

        if (text.includes("FROM users") && text.includes("password_hash IS NOT NULL")) {
            return userExists
                ? {
                    rows: [{
                        id: "7", name: "Teste", email: "teste@exemplo.com", phone: null,
                        timezone: "America/Sao_Paulo", password_hash: passwordHash, telegram_chat_id: null,
                        password_changed_at: null, email_verified_at: new Date()
                    }],
                    rowCount: 1
                }
                : { rows: [], rowCount: 0 };
        }

        if (text.startsWith("SELECT COUNT(*) AS count FROM account_deletion_attempts")) {
            const [, since] = params as [number, Date];
            return { rows: [{ count: String(deletionAttempts.filter((d) => d >= since).length) }], rowCount: 1 };
        }

        if (text.startsWith("INSERT INTO account_deletion_attempts")) {
            deletionAttempts.push(new Date());
            return { rows: [], rowCount: 1 };
        }

        if (text.startsWith("SELECT password_hash FROM users")) {
            return userExists ? { rows: [{ password_hash: passwordHash }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            return { rows: [], rowCount: 0 };
        }

        if (text.startsWith("DELETE FROM feedback WHERE user_id")) {
            deleteCalls.push("feedback");
            return { rows: [], rowCount: 0 };
        }

        if (text.startsWith("DELETE FROM users WHERE id")) {
            deleteCalls.push("users");
            userExists = false;
            return { rows: [], rowCount: 1 };
        }

        throw new Error(`fakeQuery não sabe lidar com: ${text}`);
    });

    mock.method(pool, "connect", async () => ({
        query: async (sql: string, params?: unknown[]) => {
            const result = await pool.query(sql, params);
            return result;
        },
        release: () => {}
    }));

    return { deleteCalls, isUserDeleted: () => !userExists };
}

const app = express();
app.disable("etag");
app.use(express.json());
app.use("/api/account", accountRoutes);

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
    server.close();
});

test.afterEach(() => {
    mock.restoreAll();
});

test("DELETE /api/account sem token: 401", async () => {
    const response = await fetch(`${baseUrl}/api/account`, { method: "DELETE" });
    assert.equal(response.status, 401);
});

test("DELETE /api/account sem senha no corpo: 400, sem tocar o banco", async () => {
    const passwordHash = await bcrypt.hash("senhaCorreta123", 4);
    setupDb(passwordHash);

    const response = await fetch(`${baseUrl}/api/account`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(7)}` },
        body: JSON.stringify({})
    });

    assert.equal(response.status, 400);
});

test("DELETE /api/account com senha errada: 401, conta continua existindo", async () => {
    const passwordHash = await bcrypt.hash("senhaCorreta123", 4);
    const { isUserDeleted } = setupDb(passwordHash);

    const response = await fetch(`${baseUrl}/api/account`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(7)}` },
        body: JSON.stringify({ password: "senhaErrada" })
    });

    assert.equal(response.status, 401);
    const data = await response.json();
    assert.equal(data.error, "Senha incorreta.");
    assert.equal(isUserDeleted(), false);
});

test("DELETE /api/account com senha correta: 204 e apaga feedback + usuário numa transação", async () => {
    const passwordHash = await bcrypt.hash("senhaCorreta123", 4);
    const { deleteCalls, isUserDeleted } = setupDb(passwordHash);

    const response = await fetch(`${baseUrl}/api/account`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(7)}` },
        body: JSON.stringify({ password: "senhaCorreta123" })
    });

    assert.equal(response.status, 204);
    assert.deepEqual(deleteCalls, ["feedback", "users"]);
    assert.equal(isUserDeleted(), true);
});

test("DELETE /api/account: limite de 5 tentativas por hora bloqueia a 6ª com 429", async () => {
    const passwordHash = await bcrypt.hash("senhaCorreta123", 4);
    setupDb(passwordHash);

    for (let i = 0; i < 5; i += 1) {
        const attempt = await fetch(`${baseUrl}/api/account`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(7)}` },
            body: JSON.stringify({ password: "senhaErrada" })
        });
        assert.equal(attempt.status, 401);
    }

    const sixth = await fetch(`${baseUrl}/api/account`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(7)}` },
        body: JSON.stringify({ password: "senhaCorreta123" })
    });

    assert.equal(sixth.status, 429);
});

test("usuário já apagado (token antigo reutilizado) responde 401, não quebra o servidor", async () => {
    const passwordHash = await bcrypt.hash("senhaCorreta123", 4);
    const { isUserDeleted } = setupDb(passwordHash);

    await fetch(`${baseUrl}/api/account`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(7)}` },
        body: JSON.stringify({ password: "senhaCorreta123" })
    });
    assert.ok(isUserDeleted());

    const secondAttempt = await fetch(`${baseUrl}/api/account`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(7)}` },
        body: JSON.stringify({ password: "senhaCorreta123" })
    });

    assert.equal(secondAttempt.status, 401);
});
