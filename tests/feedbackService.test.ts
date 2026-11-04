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
    type QueryExecutor
} from "../src/services/feedbackService.ts";

function makeFakeExecutor(countsByQuery: { hourly?: number; daily?: number } = {}): {
    executor: QueryExecutor;
    calls: Array<{ text: string; params: unknown[] | undefined }>;
} {
    const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
    let countCallIndex = 0;

    const executor: QueryExecutor = {
        async query(text: string, params?: unknown[]) {
            calls.push({ text, params });

            if (text.includes("SELECT COUNT(*)")) {
                const count = countCallIndex === 0 ? (countsByQuery.hourly ?? 0) : (countsByQuery.daily ?? 0);
                countCallIndex += 1;
                return { rows: [{ count: String(count) }], rowCount: 1 };
            }

            return { rows: [], rowCount: 1 };
        }
    };

    return { executor, calls };
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
    const { executor, calls } = makeFakeExecutor({ hourly: 0, daily: 0 });
    await createFeedback(42, validInput, new Date("2024-01-01T12:00:00Z"), executor);

    const insertCall = calls.find((call) => call.text.includes("INSERT INTO feedback"));
    assert.ok(insertCall);
    assert.deepEqual(insertCall.params, [42, "bug", 4, validInput.message, "lembretes", "mobile", true]);
});

test("createFeedback grava rating NULL quando a nota não foi informada", async () => {
    const { executor, calls } = makeFakeExecutor({ hourly: 0, daily: 0 });
    await createFeedback(42, { ...validInput, rating: undefined }, new Date(), executor);

    const insertCall = calls.find((call) => call.text.includes("INSERT INTO feedback"));
    assert.equal(insertCall?.params?.[2], null);
});

test("createFeedback lança FeedbackRateLimitError ao atingir o limite por hora, sem inserir", async () => {
    const { executor, calls } = makeFakeExecutor({ hourly: FEEDBACK_HOURLY_LIMIT, daily: 0 });

    await assert.rejects(
        () => createFeedback(42, validInput, new Date(), executor),
        FeedbackRateLimitError
    );
    assert.ok(!calls.some((call) => call.text.includes("INSERT INTO feedback")));
});

test("createFeedback lança FeedbackRateLimitError ao atingir o limite diário, sem inserir", async () => {
    const { executor, calls } = makeFakeExecutor({ hourly: 0, daily: FEEDBACK_DAILY_LIMIT });

    await assert.rejects(
        () => createFeedback(42, validInput, new Date(), executor),
        FeedbackRateLimitError
    );
    assert.ok(!calls.some((call) => call.text.includes("INSERT INTO feedback")));
});
