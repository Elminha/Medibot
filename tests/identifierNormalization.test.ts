import test from "node:test";
import assert from "node:assert/strict";
import {
    assertHasEmailOrPhone,
    normalizeLoginIdentifier,
    normalizePhone,
    ValidationError
} from "../src/services/identifierNormalization.ts";

test("normaliza vários formatos de telefone BR para o mesmo E.164", () => {
    const expected = "+5561999999999";
    assert.equal(normalizePhone("61999999999"), expected);
    assert.equal(normalizePhone("(61) 99999-9999"), expected);
    assert.equal(normalizePhone("61 99999 9999"), expected);
    assert.equal(normalizePhone("5561999999999"), expected);
    assert.equal(normalizePhone("+5561999999999"), expected);
    assert.equal(normalizePhone("+55 (61) 99999-9999"), expected);
});

test("normaliza telefone fixo BR (10 dígitos)", () => {
    assert.equal(normalizePhone("6133334444"), "+556133334444");
    assert.equal(normalizePhone("(61) 3333-4444"), "+556133334444");
});

test("aceita números internacionais com + e 8 a 15 dígitos", () => {
    assert.equal(normalizePhone("+12025550123"), "+12025550123");
    assert.equal(normalizePhone("+441234567"), "+441234567");
});

test("rejeita telefones inválidos", () => {
    assert.throws(() => normalizePhone(""), ValidationError);
    assert.throws(() => normalizePhone("abc"), ValidationError);
    assert.throws(() => normalizePhone("123"), ValidationError);
    assert.throws(() => normalizePhone("619999999"), ValidationError);
    assert.throws(() => normalizePhone("+1234"), ValidationError);
    assert.throws(() => normalizePhone("+5561999"), ValidationError);
    assert.throws(() => normalizePhone("+123456789012345678"), ValidationError);
});

test("login decide e-mail vs telefone pela presença de '@'", () => {
    const email = normalizeLoginIdentifier("  Usuario@Exemplo.com ");
    assert.deepEqual(email, { type: "email", value: "usuario@exemplo.com" });

    const phone = normalizeLoginIdentifier("(61) 99999-9999");
    assert.deepEqual(phone, { type: "phone", value: "+5561999999999" });
});

test("login rejeita identificador vazio ou em formato inválido", () => {
    assert.throws(() => normalizeLoginIdentifier(""), ValidationError);
    assert.throws(() => normalizeLoginIdentifier("   "), ValidationError);
    assert.throws(() => normalizeLoginIdentifier("nao-e-email@"), ValidationError);
    assert.throws(() => normalizeLoginIdentifier("abc"), ValidationError);
});

test("cadastro exige ao menos um entre e-mail e telefone", () => {
    assert.throws(() => assertHasEmailOrPhone(undefined, undefined), ValidationError);
    assert.doesNotThrow(() => assertHasEmailOrPhone("usuario@exemplo.com", undefined));
    assert.doesNotThrow(() => assertHasEmailOrPhone(undefined, "+5561999999999"));
    assert.doesNotThrow(() => assertHasEmailOrPhone("usuario@exemplo.com", "+5561999999999"));
});
