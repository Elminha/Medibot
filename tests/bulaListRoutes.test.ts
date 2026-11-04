import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import fs from "node:fs";
import express from "express";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { getDatabasePool } = await import("../src/database/database.ts");
const bulaListRoutes = (await import("../src/routes/bulaListRoutes.ts")).default;

const pool = getDatabasePool();

function tokenFor(userId: number): string {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET as string, { expiresIn: "7d" });
}

function setupAuthenticatedUser() {
    mock.method(pool, "query", async (sqlText: string, params?: unknown[]) => {
        if (sqlText.includes("FROM users")) {
            const [id] = params as [number];
            if (id !== 10) return { rows: [], rowCount: 0 };
            return {
                rows: [{
                    id: "10", name: "Usuário Teste", email: "teste@exemplo.com", phone: null,
                    timezone: "America/Sao_Paulo", password_hash: "hash", telegram_chat_id: null, password_changed_at: null
                }],
                rowCount: 1
            };
        }
        throw new Error(`fakeQuery não sabe lidar com: ${sqlText}`);
    });
}

const app = express();
app.disable("etag");
app.use(express.json());
app.use("/api/bulas", bulaListRoutes);

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
    server.close();
});

test.afterEach(() => {
    mock.restoreAll();
});

test("GET /api/bulas sem token: 401", async () => {
    const response = await fetch(`${baseUrl}/api/bulas`);
    assert.equal(response.status, 401);
});

test("GET /api/bulas com token válido devolve nomes legíveis, ordenados e com contagem", async () => {
    setupAuthenticatedUser();
    mock.method(fs.promises, "readFile", async () => JSON.stringify([
        { filename: "bula_ibuprofeno.pdf", sha256: "a", openaiFileId: "file-123", uploadedAt: "2026-01-01T00:00:00.000Z", origin: "upload" },
        { filename: "bula_acetilcisteina.pdf", sha256: "b", uploadedAt: "2026-01-01T00:00:00.000Z", origin: "legado" }
    ]));

    const response = await fetch(`${baseUrl}/api/bulas`, {
        headers: { Authorization: `Bearer ${tokenFor(10)}` }
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { bulas: ["Acetilcisteina", "Ibuprofeno"], count: 2 });
});

test("GET /api/bulas nunca expõe hash, id de arquivo da OpenAI ou caminho interno", async () => {
    setupAuthenticatedUser();
    mock.method(fs.promises, "readFile", async () => JSON.stringify([
        { filename: "bula_ibuprofeno.pdf", sha256: "segredo-hash-123", openaiFileId: "file-abc123", uploadedAt: "2026-01-01T00:00:00.000Z", origin: "upload" }
    ]));

    const response = await fetch(`${baseUrl}/api/bulas`, {
        headers: { Authorization: `Bearer ${tokenFor(10)}` }
    });

    const raw = await response.text();
    assert.doesNotMatch(raw, /segredo-hash-123|file-abc123|bula_|\.pdf|uploaded\.json/i);
});

test("GET /api/bulas devolve lista vazia quando o manifesto não existe", async () => {
    setupAuthenticatedUser();
    mock.method(fs.promises, "readFile", async () => {
        const error = new Error("not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
    });

    const response = await fetch(`${baseUrl}/api/bulas`, {
        headers: { Authorization: `Bearer ${tokenFor(10)}` }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { bulas: [], count: 0 });
});

test("GET /api/bulas devolve 500 sem detalhes quando a leitura falha inesperadamente", async () => {
    setupAuthenticatedUser();
    mock.method(fs.promises, "readFile", async () => {
        throw new Error("disco indisponível");
    });

    const response = await fetch(`${baseUrl}/api/bulas`, {
        headers: { Authorization: `Bearer ${tokenFor(10)}` }
    });

    assert.equal(response.status, 500);
    const raw = await response.text();
    assert.doesNotMatch(raw, /disco indisponível/);
});
