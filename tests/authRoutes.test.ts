import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";
process.env.APP_BASE_URL = "https://medibot.exemplo.com";

const { getDatabasePool } = await import("../src/database/database.ts");
const { emailService } = await import("../src/services/emailService.ts");
const authRoutes = (await import("../src/routes/authRoutes.ts")).default;

const jwt = (await import("jsonwebtoken")).default;

function tokenFor(userId: number): string {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET as string, { expiresIn: "7d" });
}

const pool = getDatabasePool();

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
    server.close();
});

test.afterEach(() => {
    mock.restoreAll();
    delete process.env.PASSWORD_RESET_ENABLED;
    delete process.env.EMAIL_VERIFICATION_REQUIRED;
});

test("GET /api/auth/capabilities: só o texto exato 'true' liga passwordReset", async () => {
    const cases: Array<[string | undefined, boolean]> = [
        ["true", true],
        ["false", false],
        ["TRUE", false],
        ["1", false],
        [undefined, false]
    ];

    for (const [value, expected] of cases) {
        if (value === undefined) {
            delete process.env.PASSWORD_RESET_ENABLED;
        } else {
            process.env.PASSWORD_RESET_ENABLED = value;
        }

        const response = await fetch(`${baseUrl}/api/auth/capabilities`);
        const data = await response.json();
        assert.equal(response.status, 200);
        assert.deepEqual(data, { passwordReset: expected, emailVerificationRequired: false });
    }
});

test("GET /api/auth/capabilities: só o texto exato 'true' liga emailVerificationRequired", async () => {
    const cases: Array<[string | undefined, boolean]> = [
        ["true", true],
        ["false", false],
        ["TRUE", false],
        [undefined, false]
    ];

    for (const [value, expected] of cases) {
        if (value === undefined) {
            delete process.env.EMAIL_VERIFICATION_REQUIRED;
        } else {
            process.env.EMAIL_VERIFICATION_REQUIRED = value;
        }

        const response = await fetch(`${baseUrl}/api/auth/capabilities`);
        const data = await response.json();
        assert.equal(response.status, 200);
        assert.deepEqual(data, { passwordReset: false, emailVerificationRequired: expected });
    }
});

test("POST /api/auth/forgot-password: desligada responde 404 genérico sem tocar no banco nem no e-mail", async () => {
    delete process.env.PASSWORD_RESET_ENABLED;
    const queryMock = mock.method(pool, "query", async () => {
        throw new Error("não deveria consultar o banco com o recurso desligado");
    });
    const sendMock = mock.method(emailService, "sendPasswordResetEmail", async () => {
        throw new Error("não deveria enviar e-mail com o recurso desligado");
    });

    const response = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "alguem@exemplo.com" })
    });

    assert.equal(response.status, 404);
    const data = await response.json();
    assert.equal(data.error, "Recurso indisponível.");
    assert.equal(queryMock.mock.callCount(), 0);
    assert.equal(sendMock.mock.callCount(), 0);
});

test("POST /api/auth/reset-password: desligada responde 404 genérico sem tocar no banco", async () => {
    delete process.env.PASSWORD_RESET_ENABLED;
    const queryMock = mock.method(pool, "query", async () => {
        throw new Error("não deveria consultar o banco com o recurso desligado");
    });
    const connectMock = mock.method(pool, "connect", async () => {
        throw new Error("não deveria abrir conexão com o recurso desligado");
    });

    const response = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "qualquer-token", password: "senhaBoa123" })
    });

    assert.equal(response.status, 404);
    const data = await response.json();
    assert.equal(data.error, "Recurso indisponível.");
    assert.equal(queryMock.mock.callCount(), 0);
    assert.equal(connectMock.mock.callCount(), 0);
});

test("POST /api/auth/forgot-password: ligada continua respondendo com a mensagem genérica de sucesso", async () => {
    process.env.PASSWORD_RESET_ENABLED = "true";
    mock.method(pool, "query", async (sql: string) => {
        if (sql.includes("SELECT id FROM users")) return { rows: [], rowCount: 0 };
        if (sql.includes("INSERT INTO password_reset_attempts")) return { rows: [], rowCount: 1 };
        if (sql.startsWith("DELETE FROM")) return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT COUNT(*) AS count")) return { rows: [{ count: "0" }], rowCount: 1 };
        throw new Error(`consulta inesperada: ${sql}`);
    });
    const sendMock = mock.method(emailService, "sendPasswordResetEmail", async () => {});

    const response = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ghost@exemplo.com" })
    });

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.match(data.message, /Se esse e-mail estiver cadastrado/);
    assert.equal(sendMock.mock.callCount(), 0);
});

test("POST /api/auth/reset-password: ligada continua recusando token inválido com 400", async () => {
    process.env.PASSWORD_RESET_ENABLED = "true";
    mock.method(pool, "query", async (sql: string) => {
        if (sql.includes("SELECT COUNT(*) AS count")) return { rows: [{ count: "0" }], rowCount: 1 };
        if (sql.startsWith("INSERT INTO password_reset_attempts")) return { rows: [], rowCount: 1 };
        throw new Error(`consulta inesperada: ${sql}`);
    });
    mock.method(pool, "connect", async () => ({
        query: async (sql: string) => {
            if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
            if (sql.includes("WHERE token_hash = $1 AND used_at IS NULL")) return { rows: [], rowCount: 0 };
            throw new Error(`consulta inesperada na transação: ${sql}`);
        },
        release: () => {}
    }));

    const response = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "token-invalido", password: "senhaBoa123" })
    });

    assert.equal(response.status, 400);
    const data = await response.json();
    assert.equal(data.error, "Link inválido ou expirado.");
});

function mockConfirmEmailVerification(outcome: { tokenFound: boolean; userExists?: boolean }) {
    async function handle(sql: string) {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (sql.includes("WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()")) {
            return outcome.tokenFound ? { rows: [{ user_id: "7" }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("SELECT id FROM users WHERE id = $1 FOR UPDATE")) {
            return (outcome.userExists ?? true) ? { rows: [{ id: "7" }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("UPDATE users SET email_verified_at")) return { rows: [], rowCount: 1 };
        if (sql.startsWith("UPDATE email_verification_tokens SET used_at")) return { rows: [], rowCount: 1 };
        throw new Error(`consulta inesperada: ${sql}`);
    }

    mock.method(pool, "connect", async () => ({
        query: async (sql: string) => handle(sql),
        release: () => {}
    }));
}

test("POST /api/auth/verify-email: token inválido/expirado responde 400", async () => {
    mockConfirmEmailVerification({ tokenFound: false });

    const response = await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "token-invalido" })
    });

    assert.equal(response.status, 400);
    const data = await response.json();
    assert.equal(data.error, "Link inválido ou expirado.");
});

test("POST /api/auth/verify-email: token válido confirma o e-mail", async () => {
    mockConfirmEmailVerification({ tokenFound: true });

    const response = await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "token-valido" })
    });

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.message, "E-mail confirmado com sucesso.");
});

test("POST /api/auth/verify-email: sem token responde 400 sem consultar o banco", async () => {
    const queryMock = mock.method(pool, "query", async () => {
        throw new Error("não deveria consultar o banco sem token");
    });

    const response = await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
    });

    assert.equal(response.status, 400);
    assert.equal(queryMock.mock.callCount(), 0);
});

test("POST /api/auth/resend-verification: sem token de autenticação responde 401", async () => {
    const response = await fetch(`${baseUrl}/api/auth/resend-verification`, { method: "POST" });
    assert.equal(response.status, 401);
});

function mockAuthenticatedUser(overrides: { email?: string | null; emailVerifiedAt?: Date | null } = {}) {
    mock.method(pool, "query", async (sql: string) => {
        if (sql.includes("FROM users") && sql.includes("password_hash IS NOT NULL")) {
            return {
                rows: [{
                    id: "7", name: "Teste", email: overrides.email ?? "teste@exemplo.com", phone: null,
                    timezone: "America/Sao_Paulo", password_hash: "hash", telegram_chat_id: null,
                    password_changed_at: null, email_verified_at: overrides.emailVerifiedAt ?? null
                }],
                rowCount: 1
            };
        }
        if (sql.startsWith("SELECT email, email_verified_at FROM users")) {
            return {
                rows: [{ email: overrides.email ?? "teste@exemplo.com", email_verified_at: overrides.emailVerifiedAt ?? null }],
                rowCount: 1
            };
        }
        if (sql.startsWith("SELECT COUNT(*) AS count FROM email_verification_attempts")) {
            return { rows: [{ count: "0" }], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO email_verification_attempts")) return { rows: [], rowCount: 1 };
        if (sql.startsWith("UPDATE email_verification_tokens SET used_at")) return { rows: [], rowCount: 1 };
        if (sql.startsWith("INSERT INTO email_verification_tokens")) return { rows: [], rowCount: 1 };
        throw new Error(`consulta inesperada: ${sql}`);
    });
}

test("POST /api/auth/resend-verification: usuário não verificado recebe um novo e-mail", async () => {
    mockAuthenticatedUser({ emailVerifiedAt: null });
    const sendMock = mock.method(emailService, "sendEmailVerificationEmail", async () => {});

    const response = await fetch(`${baseUrl}/api/auth/resend-verification`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenFor(7)}` }
    });

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.message, "E-mail de verificação reenviado.");
    assert.equal(sendMock.mock.callCount(), 1);
});

test("POST /api/auth/resend-verification: usuário já verificado não recebe novo e-mail", async () => {
    mockAuthenticatedUser({ emailVerifiedAt: new Date() });
    const sendMock = mock.method(emailService, "sendEmailVerificationEmail", async () => {});

    const response = await fetch(`${baseUrl}/api/auth/resend-verification`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenFor(7)}` }
    });

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.message, "Seu e-mail já está confirmado.");
    assert.equal(sendMock.mock.callCount(), 0);
});
