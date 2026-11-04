import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import crypto from "node:crypto";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { getDatabasePool } = await import("../src/database/database.ts");
const {
    AccountAlreadyExistsError,
    getAuthenticatedUser,
    isTokenRevokedByPasswordChange,
    loginUser,
    registerUser,
    TooManyRegistrationAttemptsError,
    ValidationError
} = await import("../src/services/authService.ts");

const pool = getDatabasePool();

test.afterEach(() => {
    mock.restoreAll();
});

test("isTokenRevokedByPasswordChange: nulo nunca revoga", () => {
    assert.equal(isTokenRevokedByPasswordChange(1_700_000_000_000, null), false);
});

test("isTokenRevokedByPasswordChange: token emitido ANTES da troca é revogado", () => {
    const changedAt = new Date("2024-01-01T12:00:00.500Z");
    const issuedAtMs = new Date("2024-01-01T11:59:59.000Z").getTime();
    assert.equal(isTokenRevokedByPasswordChange(issuedAtMs, changedAt), true);
});

test("isTokenRevokedByPasswordChange: token emitido no MESMO segundo (arredondado) ou depois é aceito", () => {
    const changedAt = new Date("2024-01-01T12:00:00.900Z");
    // iat tem granularidade de segundos: 12:00:00 (mesmo segundo, antes dos ms de changedAt).
    const issuedAtMsSameSecond = new Date("2024-01-01T12:00:00.000Z").getTime();
    assert.equal(isTokenRevokedByPasswordChange(issuedAtMsSameSecond, changedAt), false);

    const issuedAtMsAfter = new Date("2024-01-01T12:00:01.000Z").getTime();
    assert.equal(isTokenRevokedByPasswordChange(issuedAtMsAfter, changedAt), false);
});

test("registerUser rejeita cadastro sem e-mail", async () => {
    await assert.rejects(
        () => registerUser({ name: "Teste", password: "senha1234", phone: "+5561999999999" }),
        ValidationError
    );
});

test("registerUser aceita e-mail sem telefone", async () => {
    async function handle(sql: string) {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT 1 FROM users")) return { rows: [], rowCount: 0 };
        if (sql.includes("INSERT INTO users")) {
            return {
                rows: [
                    {
                        id: "1",
                        name: "Teste",
                        email: "teste@exemplo.com",
                        phone: null,
                        timezone: "America/Sao_Paulo",
                        password_hash: "hash",
                        telegram_chat_id: null,
                        email_verified_at: null
                    }
                ],
                rowCount: 1
            };
        }
        return { rows: [], rowCount: 0 };
    }

    mock.method(pool, "query", async (sql: string) => handle(sql));
    mock.method(pool, "connect", async () => ({
        query: async (sql: string) => handle(sql),
        release: () => {}
    }));

    const result = await registerUser({ name: "Teste", password: "senha1234", email: "teste@exemplo.com" });
    assert.equal(result.user.email, "teste@exemplo.com");
    assert.equal(result.user.phone, null);
});

test("getAuthenticatedUser recusa token emitido antes de password_changed_at e aceita um emitido depois", async () => {
    const passwordChangedAt = new Date("2024-06-01T10:00:00.000Z");

    mock.method(pool, "query", async () => ({
        rows: [
            {
                id: "42",
                name: "Teste",
                email: "teste@exemplo.com",
                phone: null,
                timezone: "America/Sao_Paulo",
                password_hash: "hash",
                telegram_chat_id: null,
                password_changed_at: passwordChangedAt
            }
        ],
        rowCount: 1
    }));

    const jwt = await import("jsonwebtoken");
    // jsonwebtoken ignora um "iat" explícito no payload por padrão só se expiresIn for
    // usado sem sobrescrevê-lo; aqui assinamos sem expiresIn para controlar o iat exato.
    const expiredToken = jwt.default.sign(
        { sub: "42", iat: Math.floor(passwordChangedAt.getTime() / 1000) - 10 },
        process.env.JWT_SECRET!
    );

    const revokedUser = await getAuthenticatedUser(expiredToken);
    assert.equal(revokedUser, undefined);

    const freshToken = jwt.default.sign(
        { sub: "42", iat: Math.floor(passwordChangedAt.getTime() / 1000) + 5 },
        process.env.JWT_SECRET!
    );
    const validUser = await getAuthenticatedUser(freshToken);
    assert.equal(validUser?.id, 42);
});

test("loginUser recusa credenciais inválidas sem revelar se o identificador existe", async () => {
    mock.method(pool, "query", async () => ({ rows: [], rowCount: 0 }));
    await assert.rejects(() => loginUser({ identifier: "ninguem@exemplo.com", password: "qualquer123" }));
});

// ===== Tomada de cadastro não verificado (requisito 5) =====

interface FakeExistingUser {
    id: number;
    email: string;
    phone: string | null;
    emailVerifiedAt: Date | null;
    hasData: boolean;
}

function setupRegisterDb(existing: FakeExistingUser[]) {
    const users = [...existing];
    const deletedIds: number[] = [];
    const insertedRows: Array<{ email: string; phone: string | null }> = [];
    const registrationAttempts: Array<{ email_hash: string; created_at: Date }> = [];

    async function handle(sql: string, params: unknown[] = []) {
        const text = sql.trim();

        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            return { rows: [], rowCount: 0 };
        }

        if (text.startsWith("SELECT COUNT(*) AS count FROM registration_attempts")) {
            const [emailHash, since] = params as [string, Date];
            const count = registrationAttempts.filter((a) => a.email_hash === emailHash && a.created_at >= since).length;
            return { rows: [{ count: String(count) }], rowCount: 1 };
        }

        if (text.startsWith("INSERT INTO registration_attempts")) {
            const [emailHash] = params as [string];
            registrationAttempts.push({ email_hash: emailHash, created_at: new Date() });
            return { rows: [], rowCount: 1 };
        }

        if (text.startsWith("SELECT 1 FROM users WHERE phone")) {
            const [phone] = params as [string];
            const match = users.find((u) => u.phone === phone && !deletedIds.includes(u.id));
            return { rows: match ? [{ x: 1 }] : [], rowCount: match ? 1 : 0 };
        }

        if (text.startsWith("SELECT id, email_verified_at FROM users WHERE email")) {
            const [email] = params as [string];
            const match = users.find((u) => u.email === email && !deletedIds.includes(u.id));
            return {
                rows: match ? [{ id: String(match.id), email_verified_at: match.emailVerifiedAt }] : [],
                rowCount: match ? 1 : 0
            };
        }

        if (text.startsWith("SELECT EXISTS")) {
            const [userId] = params as [number];
            const match = users.find((u) => u.id === userId);
            return { rows: [{ has_data: match?.hasData === true }], rowCount: 1 };
        }

        if (text.startsWith("DELETE FROM users WHERE id")) {
            const [userId] = params as [number];
            deletedIds.push(userId);
            return { rows: [], rowCount: 1 };
        }

        if (text.startsWith("INSERT INTO users")) {
            const [, email, , phone] = params as [string, string, string, string | null];
            insertedRows.push({ email, phone });
            return {
                rows: [{
                    id: "99", name: "Teste", email, phone: phone ?? null,
                    timezone: "America/Sao_Paulo", password_hash: "hash", telegram_chat_id: null,
                    email_verified_at: null
                }],
                rowCount: 1
            };
        }

        throw new Error(`fakeQuery não sabe lidar com: ${text}`);
    }

    mock.method(pool, "query", async (sql: string, params?: unknown[]) => handle(sql, params));
    mock.method(pool, "connect", async () => ({
        query: async (sql: string, params?: unknown[]) => handle(sql, params),
        release: () => {}
    }));

    return { users, deletedIds, insertedRows, registrationAttempts };
}

test("registerUser: e-mail de conta verificada nunca é substituído", async () => {
    setupRegisterDb([{ id: 1, email: "dono@exemplo.com", phone: null, emailVerifiedAt: new Date(), hasData: false }]);

    await assert.rejects(
        () => registerUser({ name: "Impostor", password: "senha1234", email: "dono@exemplo.com" }),
        AccountAlreadyExistsError
    );
});

test("registerUser: e-mail de conta não verificada COM dados não é substituído", async () => {
    setupRegisterDb([{ id: 1, email: "dono@exemplo.com", phone: null, emailVerifiedAt: null, hasData: true }]);

    await assert.rejects(
        () => registerUser({ name: "Impostor", password: "senha1234", email: "dono@exemplo.com" }),
        AccountAlreadyExistsError
    );
});

test("registerUser: e-mail de conta não verificada SEM dados é substituído pelo novo cadastro", async () => {
    const { deletedIds, insertedRows } = setupRegisterDb([
        { id: 1, email: "dono@exemplo.com", phone: null, emailVerifiedAt: null, hasData: false }
    ]);

    const result = await registerUser({ name: "Novo dono", password: "senha1234", email: "dono@exemplo.com" });

    assert.deepEqual(deletedIds, [1]);
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].email, "dono@exemplo.com");
    assert.equal(result.user.email, "dono@exemplo.com");
});

test("registerUser: telefone já em uso por outra conta nunca é substituído, mesmo sem dados", async () => {
    setupRegisterDb([{ id: 1, email: "outro@exemplo.com", phone: "+5561999999999", emailVerifiedAt: null, hasData: false }]);

    await assert.rejects(
        () => registerUser({ name: "Impostor", password: "senha1234", email: "novo@exemplo.com", phone: "+5561999999999" }),
        AccountAlreadyExistsError
    );
});

test("registerUser: limite de 3 tentativas por hora por e-mail-alvo bloqueia a 4ª tentativa de tomada", async () => {
    const { registrationAttempts } = setupRegisterDb([
        { id: 1, email: "dono@exemplo.com", phone: null, emailVerifiedAt: null, hasData: true }
    ]);

    for (let i = 0; i < 3; i += 1) {
        await assert.rejects(
            () => registerUser({ name: "Impostor", password: "senha1234", email: "dono@exemplo.com" }),
            AccountAlreadyExistsError
        );
    }
    assert.equal(registrationAttempts.length, 3);

    await assert.rejects(
        () => registerUser({ name: "Impostor", password: "senha1234", email: "dono@exemplo.com" }),
        TooManyRegistrationAttemptsError
    );
    // A 4ª tentativa (bloqueada) não é registrada: evita que o limite "resete" mais devagar.
    assert.equal(registrationAttempts.length, 3);
});

test("registerUser: limite diário (10) bloqueia mesmo com tentativas espalhadas fora da janela de 1h", async () => {
    const { registrationAttempts } = setupRegisterDb([
        { id: 1, email: "dono@exemplo.com", phone: null, emailVerifiedAt: null, hasData: true }
    ]);
    const emailHash = crypto.createHmac("sha256", process.env.JWT_SECRET as string).update("dono@exemplo.com").digest("hex");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    for (let i = 0; i < 10; i += 1) {
        registrationAttempts.push({ email_hash: emailHash, created_at: twoHoursAgo });
    }

    await assert.rejects(
        () => registerUser({ name: "Impostor", password: "senha1234", email: "dono@exemplo.com" }),
        TooManyRegistrationAttemptsError
    );
});

test("registerUser: tentativas contra e-mails diferentes não compartilham o limite", async () => {
    setupRegisterDb([
        { id: 1, email: "dono-a@exemplo.com", phone: null, emailVerifiedAt: null, hasData: true },
        { id: 2, email: "dono-b@exemplo.com", phone: null, emailVerifiedAt: null, hasData: true }
    ]);

    for (let i = 0; i < 3; i += 1) {
        await assert.rejects(
            () => registerUser({ name: "Impostor", password: "senha1234", email: "dono-a@exemplo.com" }),
            AccountAlreadyExistsError
        );
    }

    // Esgotou o limite só para dono-a; dono-b ainda não foi tentado, então segue com a
    // decisão normal (conta com dados -> 409, não 429).
    await assert.rejects(
        () => registerUser({ name: "Impostor", password: "senha1234", email: "dono-b@exemplo.com" }),
        AccountAlreadyExistsError
    );
});
