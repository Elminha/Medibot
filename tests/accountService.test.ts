import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import bcrypt from "bcrypt";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { getDatabasePool } = await import("../src/database/database.ts");
const {
    AccountDeletionRateLimitedError,
    deleteOwnAccount,
    IncorrectPasswordError
} = await import("../src/services/accountService.ts");

const pool = getDatabasePool();

interface FakeUser {
    id: number;
    passwordHash: string;
}

/**
 * Banco falso com cascata simulada à mão (medications/reminders/queries/feedback por
 * user_id, account_deletion_attempts também), para provar que apagar uma conta nunca
 * toca nos dados de outra — não dá para confiar nisso de um Postgres de verdade aqui,
 * então o próprio teste reproduz o efeito das FKs ON DELETE CASCADE/SET NULL.
 */
function setupDb() {
    const users = new Map<number, FakeUser>();
    const deletionAttempts: Array<{ user_id: number; created_at: Date }> = [];
    const feedback: Array<{ id: number; user_id: number | null }> = [];
    const queries: Array<{ id: number; user_id: number }> = [];
    const medications: Array<{ id: number; user_id: number }> = [];
    const reminders: Array<{ id: number; medication_id: number }> = [];
    let nextId = 1;

    function handle(sql: string, params: unknown[] = []) {
        const text = sql.trim();

        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            return { rows: [], rowCount: 0 };
        }

        if (text.startsWith("SELECT COUNT(*) AS count FROM account_deletion_attempts")) {
            const [userId, since] = params as [number, Date];
            const count = deletionAttempts.filter((a) => a.user_id === userId && a.created_at >= since).length;
            return { rows: [{ count: String(count) }], rowCount: 1 };
        }

        if (text.startsWith("INSERT INTO account_deletion_attempts")) {
            const [userId] = params as [number];
            deletionAttempts.push({ user_id: userId, created_at: new Date() });
            return { rows: [], rowCount: 1 };
        }

        if (text.startsWith("SELECT password_hash FROM users")) {
            const [userId] = params as [number];
            const user = users.get(userId);
            return { rows: user ? [{ password_hash: user.passwordHash }] : [], rowCount: user ? 1 : 0 };
        }

        if (text.startsWith("DELETE FROM feedback WHERE user_id")) {
            const [userId] = params as [number];
            let removed = 0;
            for (let i = feedback.length - 1; i >= 0; i -= 1) {
                if (feedback[i].user_id === userId) {
                    feedback.splice(i, 1);
                    removed += 1;
                }
            }
            return { rows: [], rowCount: removed };
        }

        if (text.startsWith("DELETE FROM users WHERE id")) {
            const [userId] = params as [number];
            if (!users.has(userId)) {
                return { rows: [], rowCount: 0 };
            }
            users.delete(userId);
            // Cascata simulada (equivalente ao ON DELETE CASCADE real nessas tabelas).
            const deletedMedicationIds = new Set(
                medications.filter((m) => m.user_id === userId).map((m) => m.id)
            );
            for (let i = medications.length - 1; i >= 0; i -= 1) {
                if (medications[i].user_id === userId) medications.splice(i, 1);
            }
            for (let i = reminders.length - 1; i >= 0; i -= 1) {
                if (deletedMedicationIds.has(reminders[i].medication_id)) reminders.splice(i, 1);
            }
            for (let i = queries.length - 1; i >= 0; i -= 1) {
                if (queries[i].user_id === userId) queries.splice(i, 1);
            }
            for (let i = deletionAttempts.length - 1; i >= 0; i -= 1) {
                if (deletionAttempts[i].user_id === userId) deletionAttempts.splice(i, 1);
            }
            return { rows: [], rowCount: 1 };
        }

        throw new Error(`fakeQuery não sabe lidar com: ${text}`);
    }

    mock.method(pool, "query", async (sql: string, params?: unknown[]) => handle(sql, params));
    mock.method(pool, "connect", async () => ({
        query: async (sql: string, params?: unknown[]) => handle(sql, params),
        release: () => {}
    }));

    return { users, deletionAttempts, feedback, queries, medications, reminders, nextId: () => nextId++ };
}

test.afterEach(() => {
    mock.restoreAll();
});

test("deleteOwnAccount: senha errada não exclui a conta", async () => {
    const { users } = setupDb();
    const passwordHash = await bcrypt.hash("senhaCorreta123", 4);
    users.set(1, { id: 1, passwordHash });

    await assert.rejects(() => deleteOwnAccount(1, "senhaErrada"), IncorrectPasswordError);
    assert.ok(users.has(1), "a conta não deveria ter sido apagada com a senha errada");
});

test("deleteOwnAccount: limite de tentativas por hora bloqueia a 6ª chamada, sem nem checar a senha", async () => {
    const { users, deletionAttempts } = setupDb();
    const passwordHash = await bcrypt.hash("senhaCorreta123", 4);
    users.set(1, { id: 1, passwordHash });

    for (let i = 0; i < 5; i += 1) {
        await assert.rejects(() => deleteOwnAccount(1, "senhaErrada"), IncorrectPasswordError);
    }
    assert.equal(deletionAttempts.length, 5);

    await assert.rejects(() => deleteOwnAccount(1, "senhaCorreta123"), AccountDeletionRateLimitedError);
    // Bloqueado pelo limite não grava uma 6ª tentativa nem apaga a conta.
    assert.equal(deletionAttempts.length, 5);
    assert.ok(users.has(1));
});

test("deleteOwnAccount: senha correta apaga a conta e TODOS os dados dela, sem tocar em outra conta", async () => {
    const { users, feedback, queries, medications, reminders } = setupDb();
    const passwordA = await bcrypt.hash("senhaDaConta1", 4);
    const passwordB = await bcrypt.hash("senhaDaConta2", 4);
    users.set(1, { id: 1, passwordHash: passwordA });
    users.set(2, { id: 2, passwordHash: passwordB });

    feedback.push({ id: 1, user_id: 1 }, { id: 2, user_id: 2 });
    queries.push({ id: 1, user_id: 1 }, { id: 2, user_id: 1 }, { id: 3, user_id: 2 });
    medications.push({ id: 10, user_id: 1 }, { id: 20, user_id: 2 });
    reminders.push({ id: 100, medication_id: 10 }, { id: 200, medication_id: 20 });

    await deleteOwnAccount(1, "senhaDaConta1");

    assert.ok(!users.has(1), "a conta 1 deveria ter sido apagada");
    assert.ok(users.has(2), "a conta 2 não deveria ter sido tocada");
    assert.deepEqual(feedback.map((f) => f.user_id), [2]);
    assert.deepEqual(queries.map((q) => q.user_id), [2]);
    assert.deepEqual(medications.map((m) => m.user_id), [2]);
    assert.deepEqual(reminders.map((r) => r.medication_id), [20]);
});
