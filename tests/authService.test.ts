import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { getDatabasePool } = await import("../src/database/database.ts");
const {
    getAuthenticatedUser,
    isTokenRevokedByPasswordChange,
    loginUser,
    registerUser,
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
    mock.method(pool, "query", async (sql: string) => {
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
                        telegram_chat_id: null
                    }
                ],
                rowCount: 1
            };
        }
        return { rows: [], rowCount: 0 };
    });

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
