import test from "node:test";
import assert from "node:assert/strict";
import {
    detectFeedbackDevice,
    FEEDBACK_MESSAGE_MAX_LENGTH,
    getFeedbackBlockedHint,
    isFeedbackFormValid,
    isValidFeedbackRating,
    isValidFeedbackType,
    mapAppViewToFeedbackView,
    remainingFeedbackCharacters
} from "../public/feedbackWidget.js";

test("mapAppViewToFeedbackView traduz as views internas do app para os valores aceitos pela API", () => {
    assert.equal(mapAppViewToFeedbackView("chat"), "chat");
    assert.equal(mapAppViewToFeedbackView("history"), "historico");
    assert.equal(mapAppViewToFeedbackView("medications"), "medicamentos");
    assert.equal(mapAppViewToFeedbackView("reminders"), "lembretes");
    assert.equal(mapAppViewToFeedbackView("telegram"), "telegram");
});

test("mapAppViewToFeedbackView usa 'chat' como padrão para uma view desconhecida", () => {
    assert.equal(mapAppViewToFeedbackView("algo-novo"), "chat");
    assert.equal(mapAppViewToFeedbackView(undefined), "chat");
});

test("detectFeedbackDevice reconhece user agents comuns de celular", () => {
    assert.equal(detectFeedbackDevice("Mozilla/5.0 (Linux; Android 13; Pixel 7)"), "mobile");
    assert.equal(detectFeedbackDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"), "mobile");
    assert.equal(detectFeedbackDevice("Mozilla/5.0 (iPad; CPU OS 17_0)"), "mobile");
});

test("detectFeedbackDevice trata o resto como desktop", () => {
    assert.equal(detectFeedbackDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "desktop");
    assert.equal(detectFeedbackDevice(undefined), "desktop");
    assert.equal(detectFeedbackDevice(""), "desktop");
});

test("isValidFeedbackType aceita só os 4 tipos", () => {
    assert.equal(isValidFeedbackType("bug"), true);
    assert.equal(isValidFeedbackType("outro"), true);
    assert.equal(isValidFeedbackType("spam"), false);
    assert.equal(isValidFeedbackType(null), false);
});

test("isValidFeedbackRating aceita só inteiros de 1 a 5", () => {
    assert.equal(isValidFeedbackRating(1), true);
    assert.equal(isValidFeedbackRating(5), true);
    assert.equal(isValidFeedbackRating(0), false);
    assert.equal(isValidFeedbackRating(6), false);
    assert.equal(isValidFeedbackRating(2.5), false);
});

test("remainingFeedbackCharacters conta a partir do limite de 2000", () => {
    assert.equal(remainingFeedbackCharacters(""), FEEDBACK_MESSAGE_MAX_LENGTH);
    assert.equal(remainingFeedbackCharacters("abc"), FEEDBACK_MESSAGE_MAX_LENGTH - 3);
    assert.equal(remainingFeedbackCharacters("a".repeat(2001)), -1);
});

test("isFeedbackFormValid exige um tipo escolhido e mensagem de 1 a 2000 caracteres (sem contar espaços nas pontas)", () => {
    assert.equal(isFeedbackFormValid("bug", "mensagem válida"), true);
    assert.equal(isFeedbackFormValid(null, "mensagem válida"), false);
    assert.equal(isFeedbackFormValid("bug", "   "), false);
    assert.equal(isFeedbackFormValid("bug", ""), false);
    assert.equal(isFeedbackFormValid("bug", "a".repeat(2000)), true);
    assert.equal(isFeedbackFormValid("bug", "a".repeat(2001)), false);
});

test("getFeedbackBlockedHint mostra o aviso do tipo primeiro quando os dois faltam", () => {
    assert.equal(getFeedbackBlockedHint(null, ""), "Escolha o tipo de feedback.");
    assert.equal(getFeedbackBlockedHint(null, "mensagem válida"), "Escolha o tipo de feedback.");
});

test("getFeedbackBlockedHint avisa sobre a mensagem quando só ela falta", () => {
    assert.equal(getFeedbackBlockedHint("bug", ""), "Escreva uma mensagem.");
    assert.equal(getFeedbackBlockedHint("bug", "   "), "Escreva uma mensagem.");
    assert.equal(getFeedbackBlockedHint("bug", "a".repeat(2001)), "Escreva uma mensagem.");
});

test("getFeedbackBlockedHint some quando tipo e mensagem estão ok", () => {
    assert.equal(getFeedbackBlockedHint("bug", "mensagem válida"), "");
});
