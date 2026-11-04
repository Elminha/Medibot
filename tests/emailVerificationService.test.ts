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
    buildVerificationLink,
    confirmEmailVerification,
    isEmailVerificationRequired,
    isEmailVerified,
    issueAndSendVerificationToken,
    resendVerificationEmail
} = await import("../src/services/emailVerificationService.ts");

const pool = getDatabasePool();

interface FakeUser {
    id: number;
    email: string | null;
    email_verified_at: Date | null;
}

interface FakeTokenRow {
    user_id: number;
    token_hash: string;
    expires_at: Date;
    used_at: Date | null;
}

interface FakeAttemptRow {
    user_id: number;
    created_at: Date;
}

function setupDb() {
    const users: FakeUser[] = [{ id: 1, email: "existente@exemplo.com", email_verified_at: null }];
    const tokens: FakeTokenRow[] = [];
    const attempts: FakeAttemptRow[] = [];

    function handle(sql: string, params: unknown[] = []) {
        const text = sql.trim();

        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            return { rows: [], rowCount: 0 };
        }

        if (text.startsWith("SELECT id FROM users WHERE id = $1 FOR UPDATE")) {
            const [id] = params as [number];
            const user = users.find((u) => u.id === id);
            return { rows: user ? [{ id: String(user.id) }] : [], rowCount: user ? 1 : 0 };
        }

        if (text.startsWith("SELECT email, email_verified_at FROM users")) {
            const [id] = params as [number];
            const user = users.find((u) => u.id === id);
            return {
                rows: user ? [{ email: user.email, email_verified_at: user.email_verified_at }] : [],
                rowCount: user ? 1 : 0
            };
        }

        if (text.startsWith("SELECT COUNT(*) AS count FROM email_verification_attempts")) {
            const [userId, since] = params as [number, Date];
            const count = attempts.filter((a) => a.user_id === userId && a.created_at >= since).length;
            return { rows: [{ count: String(count) }], rowCount: 1 };
        }

        if (text.startsWith("INSERT INTO email_verification_attempts")) {
            const [userId] = params as [number];
            attempts.push({ user_id: userId, created_at: new Date() });
            return { rows: [], rowCount: 1 };
        }

        // Claim atômico (checado antes do invalidate genérico por user_id, já que ambos
        // começam com "UPDATE email_verification_tokens").
        if (text.includes("WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()")) {
            const [tokenHash] = params as [string];
            const now = new Date();
            const row = tokens.find((t) => t.token_hash === tokenHash && t.used_at === null && t.expires_at > now);
            if (!row) return { rows: [], rowCount: 0 };
            row.used_at = now;
            return { rows: [{ user_id: String(row.user_id) }], rowCount: 1 };
        }

        if (text.startsWith("UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id")) {
            const [userId] = params as [number];
            tokens.forEach((t) => {
                if (t.user_id === userId && t.used_at === null) t.used_at = new Date();
            });
            return { rows: [], rowCount: 1 };
        }

        if (text.startsWith("INSERT INTO email_verification_tokens")) {
            const [userId, tokenHash, expiresAt] = params as [number, string, Date];
            tokens.push({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt, used_at: null });
            return { rows: [], rowCount: 1 };
        }

        if (text.startsWith("UPDATE users SET email_verified_at")) {
            const [userId] = params as [number];
            const user = users.find((u) => u.id === userId);
            if (user && !user.email_verified_at) user.email_verified_at = new Date();
            return { rows: [], rowCount: user ? 1 : 0 };
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

test("isEmailVerificationRequired só liga com o texto exato 'true'", () => {
    const original = process.env.EMAIL_VERIFICATION_REQUIRED;
    try {
        delete process.env.EMAIL_VERIFICATION_REQUIRED;
        assert.equal(isEmailVerificationRequired(), false);
        process.env.EMAIL_VERIFICATION_REQUIRED = "TRUE";
        assert.equal(isEmailVerificationRequired(), false);
        process.env.EMAIL_VERIFICATION_REQUIRED = "true";
        assert.equal(isEmailVerificationRequired(), true);
    } finally {
        if (original === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
        else process.env.EMAIL_VERIFICATION_REQUIRED = original;
    }
});

test("buildVerificationLink usa o fragment #verificar-email e o APP_BASE_URL do env", () => {
    assert.equal(buildVerificationLink("abc123"), "https://medibot.exemplo.com/#verificar-email=abc123");
});

test("issueAndSendVerificationToken gera token com validade de 24h e só o hash sha256 é armazenado", async () => {
    const { tokens } = setupDb();
    mock.method(emailService, "sendEmailVerificationEmail", async () => {});

    const before = Date.now();
    await issueAndSendVerificationToken(1, "existente@exemplo.com");

    assert.equal(tokens.length, 1);
    const [row] = tokens;
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    const ttlMs = row.expires_at.getTime() - before;
    assert.ok(ttlMs > 23 * 60 * 60_000 && ttlMs <= 24 * 60 * 60_000 + 2_000, `TTL fora do esperado: ${ttlMs}ms`);
});

test("issueAndSendVerificationToken invalida tokens anteriores do mesmo usuário ao gerar um novo", async () => {
    const { tokens } = setupDb();
    mock.method(emailService, "sendEmailVerificationEmail", async () => {});

    await issueAndSendVerificationToken(1, "existente@exemplo.com");
    await issueAndSendVerificationToken(1, "existente@exemplo.com");

    assert.equal(tokens.length, 2);
    assert.ok(tokens[0].used_at !== null, "o primeiro token deveria ter sido invalidado");
    assert.equal(tokens[1].used_at, null);
});

test("confirmEmailVerification: token expirado, usado e inexistente são todos recusados", async () => {
    const { tokens } = setupDb();
    const now = new Date();
    tokens.push(
        { user_id: 1, token_hash: createHash("sha256").update("expirado").digest("hex"), expires_at: new Date(now.getTime() - 1000), used_at: null },
        { user_id: 1, token_hash: createHash("sha256").update("usado").digest("hex"), expires_at: new Date(now.getTime() + 60_000), used_at: now }
    );

    assert.equal(await confirmEmailVerification("expirado"), "invalid");
    assert.equal(await confirmEmailVerification("usado"), "invalid");
    assert.equal(await confirmEmailVerification("nunca-existiu"), "invalid");
});

test("confirmEmailVerification: token válido marca o e-mail como verificado e invalida os demais tokens do usuário", async () => {
    const { tokens, users } = setupDb();
    const now = new Date();
    tokens.push(
        { user_id: 1, token_hash: createHash("sha256").update("valido").digest("hex"), expires_at: new Date(now.getTime() + 60_000), used_at: null },
        { user_id: 1, token_hash: createHash("sha256").update("outro-token-do-mesmo-usuario").digest("hex"), expires_at: new Date(now.getTime() + 60_000), used_at: null }
    );

    const outcome = await confirmEmailVerification("valido");

    assert.equal(outcome, "ok");
    assert.ok(users[0].email_verified_at instanceof Date);
    assert.ok(tokens.every((t) => t.used_at !== null));
});

test("confirmEmailVerification: o mesmo token não pode ser usado duas vezes", async () => {
    const { tokens } = setupDb();
    const now = new Date();
    tokens.push({
        user_id: 1,
        token_hash: createHash("sha256").update("uso-unico").digest("hex"),
        expires_at: new Date(now.getTime() + 60_000),
        used_at: null
    });

    assert.equal(await confirmEmailVerification("uso-unico"), "ok");
    assert.equal(await confirmEmailVerification("uso-unico"), "invalid");
});

test("confirmEmailVerification: conta apagada entre o claim do token e a trava da linha (tomada de cadastro concorrente) é tratada como inválida", async () => {
    const { tokens, users } = setupDb();
    const now = new Date();
    tokens.push({
        user_id: 1,
        token_hash: createHash("sha256").update("conta-apagada").digest("hex"),
        expires_at: new Date(now.getTime() + 60_000),
        used_at: null
    });
    // Simula o registerUser tendo apagado a conta (nunca verificada, sem dados) entre o
    // claim do token (tabela email_verification_tokens) e a trava da linha em users.
    users.length = 0;

    assert.equal(await confirmEmailVerification("conta-apagada"), "invalid");
});

test("isEmailVerified: true quando não há e-mail, true quando já verificado, false quando pendente", async () => {
    const { users } = setupDb();
    assert.equal(await isEmailVerified(1), false);

    users[0].email = null;
    assert.equal(await isEmailVerified(1), true);

    users[0].email = "existente@exemplo.com";
    users[0].email_verified_at = new Date();
    assert.equal(await isEmailVerified(1), true);
});

test("isEmailVerified: conta inexistente não trava o chamador (trata como verificada)", async () => {
    setupDb();
    assert.equal(await isEmailVerified(999), true);
});

test("resendVerificationEmail: conta sem e-mail cadastrado devolve 'no-email'", async () => {
    const { users } = setupDb();
    users[0].email = null;
    assert.equal(await resendVerificationEmail(1), "no-email");
});

test("resendVerificationEmail: e-mail já verificado devolve 'already-verified' sem enviar nada", async () => {
    const { users } = setupDb();
    users[0].email_verified_at = new Date();
    const sendMock = mock.method(emailService, "sendEmailVerificationEmail", async () => {});

    assert.equal(await resendVerificationEmail(1), "already-verified");
    assert.equal(sendMock.mock.callCount(), 0);
});

test("resendVerificationEmail: limite de 3 por hora bloqueia a 4ª tentativa", async () => {
    setupDb();
    mock.method(emailService, "sendEmailVerificationEmail", async () => {});

    let last;
    for (let i = 0; i < 4; i += 1) {
        last = await resendVerificationEmail(1);
    }

    assert.equal(last, "rate-limited");
});

test("resendVerificationEmail: limite de 10 por dia bloqueia mesmo espalhado em mais de uma hora", async () => {
    const { attempts } = setupDb();
    mock.method(emailService, "sendEmailVerificationEmail", async () => {});

    // 10 tentativas já registradas há mais de uma hora (não contam no limite horário,
    // mas já atingem o limite diário).
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    for (let i = 0; i < 10; i += 1) {
        attempts.push({ user_id: 1, created_at: twoHoursAgo });
    }

    assert.equal(await resendVerificationEmail(1), "rate-limited");
});

test("resendVerificationEmail: dentro do limite reenvia e registra a tentativa", async () => {
    const { attempts } = setupDb();
    const sendMock = mock.method(emailService, "sendEmailVerificationEmail", async () => {});

    const outcome = await resendVerificationEmail(1);

    assert.equal(outcome, "ok");
    assert.equal(sendMock.mock.callCount(), 1);
    assert.equal(attempts.length, 1);
});
