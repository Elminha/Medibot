import test from "node:test";
import assert from "node:assert/strict";
import { hasExceededHourlyLimit, TELEGRAM_HOURLY_QUESTION_LIMIT } from "../src/services/telegramRateLimiter.ts";

test("não excede o limite enquanto a contagem estiver abaixo dele", () => {
    assert.equal(hasExceededHourlyLimit(0), false);
    assert.equal(hasExceededHourlyLimit(TELEGRAM_HOURLY_QUESTION_LIMIT - 1), false);
});

test("excede o limite quando a contagem alcança ou passa o limite padrão", () => {
    assert.equal(hasExceededHourlyLimit(TELEGRAM_HOURLY_QUESTION_LIMIT), true);
    assert.equal(hasExceededHourlyLimit(TELEGRAM_HOURLY_QUESTION_LIMIT + 5), true);
});

test("aceita um limite customizado", () => {
    assert.equal(hasExceededHourlyLimit(4, 5), false);
    assert.equal(hasExceededHourlyLimit(5, 5), true);
});
