import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { getDatabasePool } = await import("../src/database/database.ts");
const { requireAuthentication, requireVerifiedEmail } = await import("../src/middleware/authMiddleware.ts");

const pool = getDatabasePool();

function tokenFor(userId: number): string {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET as string, { expiresIn: "7d" });
}

function mockUser(overrides: { email?: string | null; emailVerifiedAt?: Date | null } = {}) {
    const email = "email" in overrides ? overrides.email : "teste@exemplo.com";
    mock.method(pool, "query", async () => ({
        rows: [{
            id: "1", name: "Teste", email, phone: null,
            timezone: "America/Sao_Paulo", password_hash: "hash", telegram_chat_id: null,
            password_changed_at: null, email_verified_at: overrides.emailVerifiedAt ?? null
        }],
        rowCount: 1
    }));
}

// Mesma composição usada nos routers reais (bula, medicamentos, lembretes, histórico,
// feedback, lista de bulas e as rotas autenticadas do Telegram): requireAuthentication
// seguido de requireVerifiedEmail.
const app = express();
app.get("/protegido", requireAuthentication, requireVerifiedEmail, (_request, response) => {
    response.json({ ok: true });
});

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
    server.close();
});

test.afterEach(() => {
    mock.restoreAll();
    delete process.env.EMAIL_VERIFICATION_REQUIRED;
});

test("flag desligada (padrão): usuário não verificado acessa normalmente", async () => {
    delete process.env.EMAIL_VERIFICATION_REQUIRED;
    mockUser({ emailVerifiedAt: null });

    const response = await fetch(`${baseUrl}/protegido`, { headers: { Authorization: `Bearer ${tokenFor(1)}` } });
    assert.equal(response.status, 200);
});

test("flag ligada: usuário não verificado recebe 403 com o código EMAIL_NOT_VERIFIED", async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    mockUser({ emailVerifiedAt: null });

    const response = await fetch(`${baseUrl}/protegido`, { headers: { Authorization: `Bearer ${tokenFor(1)}` } });
    assert.equal(response.status, 403);
    const data = await response.json();
    assert.equal(data.code, "EMAIL_NOT_VERIFIED");
});

test("flag ligada: usuário verificado acessa normalmente (libera após verificar)", async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    mockUser({ emailVerifiedAt: new Date() });

    const response = await fetch(`${baseUrl}/protegido`, { headers: { Authorization: `Bearer ${tokenFor(1)}` } });
    assert.equal(response.status, 200);
});

test("flag ligada: conta sem e-mail (legado, só telefone) nunca é bloqueada", async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    mockUser({ email: null, emailVerifiedAt: null });

    const response = await fetch(`${baseUrl}/protegido`, { headers: { Authorization: `Bearer ${tokenFor(1)}` } });
    assert.equal(response.status, 200);
});

test("flag ligada: sem token de autenticação ainda responde 401 (requireAuthentication roda primeiro)", async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    const response = await fetch(`${baseUrl}/protegido`);
    assert.equal(response.status, 401);
});
