import test from "node:test";
import assert from "node:assert/strict";
import { formatResendCooldownLabel, maskEmail, resolveAfterVerificationAction } from "../public/emailVerification.js";

test("maskEmail mascara local e domínio preservando o TLD", () => {
    assert.equal(maskEmail("leandro.cortes@gmail.com"), "le***@g***.com");
});

test("maskEmail lida com local curto (1-2 caracteres)", () => {
    assert.equal(maskEmail("ab@exemplo.com"), "a***@e***.com");
    assert.equal(maskEmail("a@exemplo.com"), "a***@e***.com");
});

test("maskEmail sem '@' ou valor inválido devolve o próprio valor/vazio", () => {
    assert.equal(maskEmail("nao-e-email"), "nao-e-email");
    assert.equal(maskEmail(""), "");
    assert.equal(maskEmail(undefined), "");
    assert.equal(maskEmail(null), "");
});

test("maskEmail sem ponto no domínio ainda mascara o local", () => {
    assert.equal(maskEmail("usuario@localhost"), "us***@localhost");
});

test("formatResendCooldownLabel devolve vazio quando não há cooldown", () => {
    assert.equal(formatResendCooldownLabel(0), "");
    assert.equal(formatResendCooldownLabel(-500), "");
});

test("formatResendCooldownLabel arredonda para cima e mostra segundos restantes", () => {
    assert.equal(formatResendCooldownLabel(60_000), "Reenviar em 60s");
    assert.equal(formatResendCooldownLabel(500), "Reenviar em 1s");
    assert.equal(formatResendCooldownLabel(1_001), "Reenviar em 2s");
});

test("resolveAfterVerificationAction entra direto quando já há sessão neste navegador", () => {
    assert.equal(resolveAfterVerificationAction(true), "continue-session");
});

test("resolveAfterVerificationAction manda para o login quando não há sessão guardada", () => {
    assert.equal(resolveAfterVerificationAction(false), "go-to-login");
    assert.equal(resolveAfterVerificationAction(""), "go-to-login");
});
