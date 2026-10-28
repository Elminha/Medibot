import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { createHash } from "node:crypto";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";
process.env.APP_BASE_URL = "https://medibot.exemplo.com";

const { getDatabasePool } = await import("../src/database/database.ts");
const { emailService } = await import("../src/services/emailService.ts");
const {
    buildResetLink,
    confirmPasswordReset,
    getAppBaseUrl,
    GENERIC_REQUEST_MESSAGE,
    hashIdentifier,
    PasswordResetConfigurationError,
    requestPasswordReset
} = await import("../src/services/passwordResetService.ts");

const pool = getDatabasePool();

interface FakeUser {
    id: number;
    email: string;
}

interface FakeTokenRow {
    user_id: number;
    token_hash: string;
    expires_at: Date;
    used_at: Date | null;
}

interface FakeAttemptRow {
    email_hash: string | null;
    ip_hash: string | null;
    kind: "request" | "confirm";
    created_at: Date;
}

function setupDb() {
    const users: FakeUser[] = [{ id: 1, email: "existente@exemplo.com" }];
    const tokens: FakeTokenRow[] = [];
    const attempts: FakeAttemptRow[] = [];

    function handle(sql: string, params: unknown[] = []) {
        const text = sql.trim();

        if (text.startsWith("SELECT id FROM users")) {
            const user = users.find((u) => u.email === params[0]);
            return { rows: user ? [{ id: String(user.id) }] : [], rowCount: user ? 1 : 0 };
        }

        if (text.includes("SELECT COUNT(*) AS count FROM password_reset_attempts") && text.includes("email_hash = $1")) {
            const [emailHash, since] = params as [string, Date];
            const count = attempts.filter(
                (a) => a.email_hash === emailHash && a.kind === "request" && a.created_at >= since
            ).length;
            return { rows: [{ count: String(count) }], rowCount: 1 };
        }

        if (text.includes("SELECT COUNT(*) AS count FROM password_reset_attempts") && text.includes("ip_hash = $1 AND kind = 'request'")) {
            const [ipHash, since] = params as [string, Date];
            const count = attempts.filter(
                (a) => a.ip_hash === ipHash && a.kind === "request" && a.created_at >= since
            ).length;
            return { rows: [{ count: String(count) }], rowCount: 1 };
        }

        if (text.includes("SELECT COUNT(*) AS count FROM password_reset_attempts") && text.includes("ip_hash = $1 AND kind = 'confirm'")) {
            const [ipHash, since] = params as [string, Date];
            const count = attempts.filter(
                (a) => a.ip_hash === ipHash && a.kind === "confirm" && a.created_at >= since
            ).length;
            return { rows: [{ count: String(count) }], rowCount: 1 };
        }

        if (text.startsWith("INSERT INTO password_reset_attempts (email_hash, ip_hash, kind)")) {
            const [emailHash, ipHash] = params as [string, string];
            attempts.push({ email_hash: emailHash, ip_hash: ipHash, kind: "request", created_at: new Date() });
            return { rows: [], rowCount: 1 };
        }

        if (text.startsWith("INSERT INTO password_reset_attempts (ip_hash, kind)")) {
            const [ipHash] = params as [string];
            attempts.push({ email_hash: null, ip_hash: ipHash, kind: "confirm", created_at: new Date() });
            return { rows: [], rowCount: 1 };
        }

        // Claim atômico usado dentro da transação de confirmPasswordReset (checado ANTES
        // do invalidate-genérico por user_id, já que ambos começam com "UPDATE password_reset_tokens").
        if (text.includes("WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()")) {
            const [tokenHash] = params as [string];
            const now = new Date();
            const row = tokens.find((t) => t.token_hash === tokenHash && t.used_at === null && t.expires_at > now);
            if (!row) return { rows: [], rowCount: 0 };
            row.used_at = now;
            return { rows: [{ user_id: String(row.user_id) }], rowCount: 1 };
        }

        if (text.startsWith("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id")) {
            const [userId] = params as [number];
            tokens.forEach((t) => {
                if (t.user_id === userId && t.used_at === null) t.used_at = new Date();
            });
            return { rows: [], rowCount: 1 };
        }

        if (text.startsWith("INSERT INTO password_reset_tokens")) {
            const [userId, tokenHash, expiresAt] = params as [number, string, Date];
            tokens.push({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt, used_at: null });
            return { rows: [], rowCount: 1 };
        }

        if (text.startsWith("UPDATE users SET password_hash")) {
            const [passwordHash, userId] = params as [string, number];
            const user = users.find((u) => u.id === userId);
            if (user) (user as FakeUser & { password_hash?: string }).password_hash = passwordHash;
            return { rows: [], rowCount: user ? 1 : 0 };
        }

        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            return { rows: [], rowCount: 0 };
        }

        if (text.startsWith("DELETE FROM password_reset_tokens") || text.startsWith("DELETE FROM password_reset_attempts")) {
            return { rows: [], rowCount: 0 };
        }

        throw new Error(`fakeQuery não sabe lidar com: ${text}`);
    }

    mock.method(pool, "query", async (sql: string, params?: unknown[]) => handle(sql, params));
    mock.method(pool, "connect", async () => ({
        query: async (sql: string, params?: unknown[]) => handle(sql, params),
        release: () => {}
    }));

    return { users, tokens, attempts };
}

test.afterEach(() => {
    mock.restoreAll();
});

test("getAppBaseUrl/buildResetLink nunca dependem de Host/Origin — só do env", () => {
    const link = buildResetLink("abc123");
    assert.equal(link, "https://medibot.exemplo.com/#redefinir=abc123");
    assert.equal(getAppBaseUrl(), "https://medibot.exemplo.com");
});

test("APP_BASE_URL ausente falha fechado: resposta genérica, sem enviar e-mail", async () => {
    setupDb();
    const sendMock = mock.method(emailService, "sendPasswordResetEmail", async () => {});
    const original = process.env.APP_BASE_URL;
    delete process.env.APP_BASE_URL;

    try {
        const outcome = await requestPasswordReset("existente@exemplo.com", "203.0.113.1");
        assert.equal(outcome.status, "ok");
        assert.equal(outcome.message, GENERIC_REQUEST_MESSAGE);
        assert.equal(sendMock.mock.callCount(), 0);
    } finally {
        process.env.APP_BASE_URL = original;
    }
});

test("APP_BASE_URL inválida (não-https, não-localhost) é rejeitada por getAppBaseUrl", () => {
    const original = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = "http://meusite.com";
    try {
        assert.throws(() => getAppBaseUrl(), PasswordResetConfigurationError);
    } finally {
        process.env.APP_BASE_URL = original;
    }
});

test("resposta idêntica para e-mail existente e inexistente; e-mail só é enviado para o existente", async () => {
    setupDb();
    const sendMock = mock.method(emailService, "sendPasswordResetEmail", async () => {});

    const forExisting = await requestPasswordReset("existente@exemplo.com", "203.0.113.1");
    const forGhost = await requestPasswordReset("ghost@exemplo.com", "203.0.113.2");

    assert.deepEqual(forExisting, forGhost);
    assert.equal(sendMock.mock.callCount(), 1);
    assert.equal(sendMock.mock.calls[0].arguments[0], "existente@exemplo.com");
});

test("resposta é equalizada por um atraso mínimo, exista ou não o e-mail", async () => {
    setupDb();
    mock.method(emailService, "sendPasswordResetEmail", async () => {});

    const startExisting = Date.now();
    await requestPasswordReset("existente@exemplo.com", "203.0.113.1");
    const elapsedExisting = Date.now() - startExisting;

    const startGhost = Date.now();
    await requestPasswordReset("ghost@exemplo.com", "203.0.113.3");
    const elapsedGhost = Date.now() - startGhost;

    assert.ok(elapsedExisting >= 750, `esperava >= 750ms, obteve ${elapsedExisting}ms`);
    assert.ok(elapsedGhost >= 750, `esperava >= 750ms, obteve ${elapsedGhost}ms`);
});

test("limite por e-mail: a 4ª tentativa na mesma hora é bloqueada com a mesma mensagem genérica", async () => {
    setupDb();
    mock.method(emailService, "sendPasswordResetEmail", async () => {});

    let last;
    for (let i = 0; i < 4; i += 1) {
        last = await requestPasswordReset("existente@exemplo.com", `198.51.100.${i}`);
    }

    assert.equal(last?.status, "rate-limited");
    assert.equal(last?.message, GENERIC_REQUEST_MESSAGE);
});

test("limite por IP: a 11ª tentativa do mesmo IP na mesma hora é bloqueada", async () => {
    setupDb();
    mock.method(emailService, "sendPasswordResetEmail", async () => {});

    let last;
    for (let i = 0; i < 11; i += 1) {
        last = await requestPasswordReset(`fulano${i}@exemplo.com`, "198.51.100.50");
    }

    assert.equal(last?.status, "rate-limited");
});

test("falha ao enviar o e-mail não é logada com o link/token, e ainda responde genérico", async () => {
    setupDb();
    mock.method(emailService, "sendPasswordResetEmail", async () => {
        throw new Error("falha simulada de SMTP");
    });
    const errorMock = mock.method(console, "error", () => {});

    const outcome = await requestPasswordReset("existente@exemplo.com", "203.0.113.9");

    assert.equal(outcome.status, "ok");
    assert.ok(errorMock.mock.callCount() >= 1);
    for (const call of errorMock.mock.calls) {
        const serialized = call.arguments.map((a) => String(a)).join(" ");
        assert.doesNotMatch(serialized, /redefinir=/);
        assert.doesNotMatch(serialized, /existente@exemplo\.com/);
    }
});

test("token é gerado com validade de 30 minutos e só o hash sha256 é armazenado", async () => {
    const { tokens } = setupDb();
    mock.method(emailService, "sendPasswordResetEmail", async () => {});

    const before = Date.now();
    await requestPasswordReset("existente@exemplo.com", "203.0.113.5");

    assert.equal(tokens.length, 1);
    const [row] = tokens;
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    const ttlMs = row.expires_at.getTime() - before;
    assert.ok(ttlMs > 29 * 60_000 && ttlMs <= 30 * 60_000 + 2_000, `TTL fora do esperado: ${ttlMs}ms`);
});

test("confirmPasswordReset: token expirado, usado e inexistente são todos recusados", async () => {
    const { tokens } = setupDb();

    const now = new Date();
    tokens.push(
        { user_id: 1, token_hash: createHash("sha256").update("expirado").digest("hex"), expires_at: new Date(now.getTime() - 1000), used_at: null },
        { user_id: 1, token_hash: createHash("sha256").update("usado").digest("hex"), expires_at: new Date(now.getTime() + 60_000), used_at: now }
    );

    assert.equal(await confirmPasswordReset("expirado", "novaSenha123", "203.0.113.10"), "invalid");
    assert.equal(await confirmPasswordReset("usado", "novaSenha123", "203.0.113.11"), "invalid");
    assert.equal(await confirmPasswordReset("nunca-existiu", "novaSenha123", "203.0.113.12"), "invalid");
});

test("confirmPasswordReset: token válido troca a senha e invalida os demais tokens do usuário", async () => {
    const { tokens } = setupDb();
    const now = new Date();
    tokens.push(
        { user_id: 1, token_hash: createHash("sha256").update("valido").digest("hex"), expires_at: new Date(now.getTime() + 60_000), used_at: null },
        { user_id: 1, token_hash: createHash("sha256").update("outro-token-do-mesmo-usuario").digest("hex"), expires_at: new Date(now.getTime() + 60_000), used_at: null }
    );

    const outcome = await confirmPasswordReset("valido", "novaSenhaForte1", "203.0.113.13");

    assert.equal(outcome, "ok");
    assert.ok(tokens.every((t) => t.used_at !== null));
});

test("confirmPasswordReset: uso único mesmo com duas confirmações simultâneas do mesmo token", async () => {
    const { tokens } = setupDb();
    const now = new Date();
    tokens.push({
        user_id: 1,
        token_hash: createHash("sha256").update("concorrente").digest("hex"),
        expires_at: new Date(now.getTime() + 60_000),
        used_at: null
    });

    const [first, second] = await Promise.all([
        confirmPasswordReset("concorrente", "novaSenhaForte1", "203.0.113.14"),
        confirmPasswordReset("concorrente", "novaSenhaForte1", "203.0.113.14")
    ]);

    const outcomes = [first, second].sort();
    assert.deepEqual(outcomes, ["invalid", "ok"]);
});

test("confirmPasswordReset: senha fraca é recusada sem consumir o token", async () => {
    const { tokens } = setupDb();
    const now = new Date();
    tokens.push({
        user_id: 1,
        token_hash: createHash("sha256").update("token-senha-fraca").digest("hex"),
        expires_at: new Date(now.getTime() + 60_000),
        used_at: null
    });

    await assert.rejects(() => confirmPasswordReset("token-senha-fraca", "123", "203.0.113.15"));
    assert.equal(tokens[0].used_at, null);

    const outcome = await confirmPasswordReset("token-senha-fraca", "senhaBoaAgora1", "203.0.113.15");
    assert.equal(outcome, "ok");
});

test("confirmPasswordReset: limite de 20 confirmações por hora por IP", async () => {
    setupDb();

    let last: Awaited<ReturnType<typeof confirmPasswordReset>> | undefined;
    for (let i = 0; i < 21; i += 1) {
        last = await confirmPasswordReset(`token-inexistente-${i}`, "senhaBoaAgora1", "198.51.100.77");
    }

    assert.equal(last, "rate-limited");
});

test("hashIdentifier é determinístico e depende do JWT_SECRET (HMAC)", () => {
    const a = hashIdentifier("alguem@exemplo.com");
    const b = hashIdentifier("alguem@exemplo.com");
    const c = hashIdentifier("outro@exemplo.com");
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{64}$/);
});
