import test from "node:test";
import assert from "node:assert/strict";
import {
    createFeedback,
    FEEDBACK_DAILY_LIMIT,
    FEEDBACK_HOURLY_LIMIT,
    FeedbackRateLimitError,
    hasExceededFeedbackRateLimit,
    isFeedbackDevice,
    isFeedbackType,
    isFeedbackView,
    isValidFeedbackRating,
    validateFeedbackMessage,
    type FeedbackInput,
    type PoolExecutor
} from "../src/services/feedbackService.ts";

/**
 * Pool falso de uma única conexão: BEGIN/COMMIT/ROLLBACK e o lock são apenas registrados.
 * `options.insertShouldThrow` simula uma falha inesperada (ex.: erro de conexão) no INSERT,
 * para testar que o client é liberado (finally) e o ROLLBACK roda mesmo nesse caminho.
 */
function makeFakePool(
    countsByQuery: { hourly?: number; daily?: number } = {},
    options: { insertShouldThrow?: boolean } = {}
): {
    pool: PoolExecutor;
    calls: Array<{ text: string; params: unknown[] | undefined }>;
    releaseCallCount: { count: number };
} {
    const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
    const releaseCallCount = { count: 0 };
    let countCallIndex = 0;

    async function query(text: string, params?: unknown[]) {
        calls.push({ text, params });

        if (text.includes("SELECT COUNT(*)")) {
            const count = countCallIndex === 0 ? (countsByQuery.hourly ?? 0) : (countsByQuery.daily ?? 0);
            countCallIndex += 1;
            return { rows: [{ count: String(count) }], rowCount: 1 };
        }

        if (text.startsWith("INSERT INTO feedback") && options.insertShouldThrow) {
            throw new Error("falha simulada de conexão no INSERT");
        }

        return { rows: [], rowCount: 1 };
    }

    const pool: PoolExecutor = {
        async connect() {
            return {
                query,
                release: () => { releaseCallCount.count += 1; }
            };
        }
    };

    return { pool, calls, releaseCallCount };
}

/**
 * Pool falso com advisory lock e contagem de verdade a partir das linhas inseridas,
 * para testar que requisições concorrentes do mesmo usuário são serializadas (e portanto
 * não ultrapassam o limite por conta de uma corrida entre a contagem e o INSERT).
 */
function makeFakePoolWithLocking(initialRowsByUser: Record<number, number> = {}): {
    pool: PoolExecutor;
    countRowsForUser: (userId: number) => number;
} {
    const rowCountsByUser = new Map<number, number>(Object.entries(initialRowsByUser).map(([id, count]) => [Number(id), count]));
    const lockQueues = new Map<number, Promise<void>>();

    async function acquireLock(userId: number): Promise<() => void> {
        const previous = lockQueues.get(userId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        lockQueues.set(userId, previous.then(() => current));
        await previous;
        return release;
    }

    const pool: PoolExecutor = {
        async connect() {
            let releaseLock: (() => void) | undefined;
            let pendingUserId: number | undefined;

            return {
                async query(text: string, params?: unknown[]) {
                    const sql = text.trim();

                    if (sql.startsWith("BEGIN")) return { rows: [], rowCount: 0 };

                    if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
                        const [, userId] = params as [number, number];
                        releaseLock = await acquireLock(userId);
                        return { rows: [], rowCount: 0 };
                    }

                    if (sql.includes("SELECT COUNT(*)")) {
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        const [userId] = params as [number, Date];
                        return { rows: [{ count: String(rowCountsByUser.get(userId) ?? 0) }], rowCount: 1 };
                    }

                    if (sql.startsWith("INSERT INTO feedback")) {
                        const [userId] = params as [number];
                        pendingUserId = userId;
                        return { rows: [], rowCount: 1 };
                    }

                    if (sql.startsWith("COMMIT")) {
                        if (pendingUserId !== undefined) {
                            rowCountsByUser.set(pendingUserId, (rowCountsByUser.get(pendingUserId) ?? 0) + 1);
                        }
                        releaseLock?.();
                        return { rows: [], rowCount: 0 };
                    }

                    if (sql.startsWith("ROLLBACK")) {
                        releaseLock?.();
                        return { rows: [], rowCount: 0 };
                    }

                    throw new Error(`fakeQuery não sabe lidar com: ${sql}`);
                },
                release() {}
            };
        }
    };

    return { pool, countRowsForUser: (userId: number) => rowCountsByUser.get(userId) ?? 0 };
}

const validInput: FeedbackInput = {
    type: "bug",
    rating: 4,
    message: "Encontrei um problema ao abrir os lembretes.",
    view: "lembretes",
    device: "mobile",
    contactOk: true
};

test("isFeedbackType aceita só os 4 tipos válidos", () => {
    assert.equal(isFeedbackType("bug"), true);
    assert.equal(isFeedbackType("sugestao"), true);
    assert.equal(isFeedbackType("elogio"), true);
    assert.equal(isFeedbackType("outro"), true);
    assert.equal(isFeedbackType("spam"), false);
    assert.equal(isFeedbackType(undefined), false);
    assert.equal(isFeedbackType(123), false);
});

test("isFeedbackView e isFeedbackDevice aceitam só os valores da lista permitida", () => {
    assert.equal(isFeedbackView("chat"), true);
    assert.equal(isFeedbackView("historico"), true);
    assert.equal(isFeedbackView("pagina-secreta"), false);
    assert.equal(isFeedbackDevice("mobile"), true);
    assert.equal(isFeedbackDevice("desktop"), true);
    assert.equal(isFeedbackDevice("tablet"), false);
});

test("isValidFeedbackRating aceita só inteiros de 1 a 5", () => {
    assert.equal(isValidFeedbackRating(1), true);
    assert.equal(isValidFeedbackRating(5), true);
    assert.equal(isValidFeedbackRating(0), false);
    assert.equal(isValidFeedbackRating(6), false);
    assert.equal(isValidFeedbackRating(3.5), false);
    assert.equal(isValidFeedbackRating("3"), false);
});

test("validateFeedbackMessage corta espaços nas pontas e exige 1 a 2000 caracteres", () => {
    assert.equal(validateFeedbackMessage("  Olá  "), "Olá");
    assert.equal(validateFeedbackMessage("   "), undefined);
    assert.equal(validateFeedbackMessage(""), undefined);
    assert.equal(validateFeedbackMessage("a".repeat(2000)), "a".repeat(2000));
    assert.equal(validateFeedbackMessage("a".repeat(2001)), undefined);
    assert.equal(validateFeedbackMessage(123), undefined);
});

test("hasExceededFeedbackRateLimit respeita os limites de 5/hora e 20/dia", () => {
    assert.equal(hasExceededFeedbackRateLimit(FEEDBACK_HOURLY_LIMIT - 1, 0), false);
    assert.equal(hasExceededFeedbackRateLimit(FEEDBACK_HOURLY_LIMIT, 0), true);
    assert.equal(hasExceededFeedbackRateLimit(0, FEEDBACK_DAILY_LIMIT - 1), false);
    assert.equal(hasExceededFeedbackRateLimit(0, FEEDBACK_DAILY_LIMIT), true);
});

test("createFeedback insere com os parâmetros corretos quando dentro do limite", async () => {
    const { pool, calls, releaseCallCount } = makeFakePool({ hourly: 0, daily: 0 });
    await createFeedback(42, validInput, new Date("2024-01-01T12:00:00Z"), pool);

    const insertCall = calls.find((call) => call.text.includes("INSERT INTO feedback"));
    assert.ok(insertCall);
    assert.deepEqual(insertCall.params, [42, "bug", 4, validInput.message, "lembretes", "mobile", true]);
    assert.ok(calls.some((call) => call.text.startsWith("COMMIT")));

    // Chave composta (namespace, userId): evita que outra feature travando por um id
    // numérico qualquer colida com o lock do feedback no mesmo keyspace de advisory locks.
    const lockCall = calls.find((call) => call.text.includes("pg_advisory_xact_lock"));
    assert.ok(lockCall);
    assert.equal(lockCall.params?.length, 2);
    assert.equal(lockCall.params?.[1], 42);
    assert.notEqual(lockCall.params?.[0], 42);

    assert.equal(releaseCallCount.count, 1);
});

test("createFeedback grava rating NULL quando a nota não foi informada", async () => {
    const { pool, calls } = makeFakePool({ hourly: 0, daily: 0 });
    await createFeedback(42, { ...validInput, rating: undefined }, new Date(), pool);

    const insertCall = calls.find((call) => call.text.includes("INSERT INTO feedback"));
    assert.equal(insertCall?.params?.[2], null);
});

test("createFeedback lança FeedbackRateLimitError ao atingir o limite por hora, sem inserir, e libera o client", async () => {
    const { pool, calls, releaseCallCount } = makeFakePool({ hourly: FEEDBACK_HOURLY_LIMIT, daily: 0 });

    await assert.rejects(
        () => createFeedback(42, validInput, new Date(), pool),
        FeedbackRateLimitError
    );
    assert.ok(!calls.some((call) => call.text.includes("INSERT INTO feedback")));
    assert.ok(calls.some((call) => call.text.startsWith("ROLLBACK")));
    assert.ok(!calls.some((call) => call.text.startsWith("COMMIT")));
    assert.equal(releaseCallCount.count, 1);
});

test("createFeedback lança FeedbackRateLimitError ao atingir o limite diário, sem inserir", async () => {
    const { pool, calls, releaseCallCount } = makeFakePool({ hourly: 0, daily: FEEDBACK_DAILY_LIMIT });

    await assert.rejects(
        () => createFeedback(42, validInput, new Date(), pool),
        FeedbackRateLimitError
    );
    assert.ok(!calls.some((call) => call.text.includes("INSERT INTO feedback")));
    assert.equal(releaseCallCount.count, 1);
});

test("createFeedback libera o client e faz ROLLBACK quando o INSERT falha por um erro inesperado (não FeedbackRateLimitError)", async () => {
    const { pool, calls, releaseCallCount } = makeFakePool({ hourly: 0, daily: 0 }, { insertShouldThrow: true });

    await assert.rejects(
        () => createFeedback(42, validInput, new Date(), pool),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok(!(error instanceof FeedbackRateLimitError));
            assert.equal(error.message, "falha simulada de conexão no INSERT");
            return true;
        }
    );

    assert.ok(calls.some((call) => call.text.startsWith("ROLLBACK")));
    assert.ok(!calls.some((call) => call.text.startsWith("COMMIT")));
    assert.equal(releaseCallCount.count, 1);
});

test("createFeedback usa um advisory lock por usuário para serializar requisições concorrentes (sem ultrapassar o limite por corrida)", async () => {
    const { pool, countRowsForUser } = makeFakePoolWithLocking({ 42: FEEDBACK_HOURLY_LIMIT - 1 });
    const now = new Date("2024-01-01T12:00:00Z");

    const results = await Promise.allSettled([
        createFeedback(42, validInput, now, pool),
        createFeedback(42, validInput, now, pool)
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof FeedbackRateLimitError);
    assert.equal(countRowsForUser(42), FEEDBACK_HOURLY_LIMIT);
});

test("createFeedback não deixa duas requisições concorrentes de usuários diferentes se bloquearem", async () => {
    const { pool, countRowsForUser } = makeFakePoolWithLocking({});
    const now = new Date("2024-01-01T12:00:00Z");

    const results = await Promise.allSettled([
        createFeedback(1, validInput, now, pool),
        createFeedback(2, validInput, now, pool)
    ]);

    assert.ok(results.every((result) => result.status === "fulfilled"));
    assert.equal(countRowsForUser(1), 1);
    assert.equal(countRowsForUser(2), 1);
});
