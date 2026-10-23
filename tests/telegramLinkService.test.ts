import test from "node:test";
import assert from "node:assert/strict";
import {
    buildTelegramDeepLink,
    generateLinkCode,
    hashLinkCode,
    isLinkCodeExpired,
    isLinkCodeUsed,
    LINK_CODE_LENGTH,
    TelegramConfigurationError
} from "../src/services/telegramLinkService.ts";

test("gera código apenas com o alfabeto sem caracteres ambíguos e no tamanho esperado", () => {
    for (let i = 0; i < 20; i += 1) {
        const code = generateLinkCode();
        assert.equal(code.length, LINK_CODE_LENGTH);
        assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/);
        assert.doesNotMatch(code, /[0O1IL]/);
    }
});

test("hashLinkCode é determinístico e ignora caixa/espaços nas bordas", () => {
    const a = hashLinkCode("abc123def");
    const b = hashLinkCode(" ABC123DEF ");
    const c = hashLinkCode("abc123deg");

    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(a.length, 64);
});

test("isLinkCodeExpired compara corretamente contra 'agora'", () => {
    const now = new Date("2024-01-01T12:00:00Z");
    assert.equal(isLinkCodeExpired(new Date("2024-01-01T11:59:59Z"), now), true);
    assert.equal(isLinkCodeExpired(new Date("2024-01-01T12:00:00Z"), now), true);
    assert.equal(isLinkCodeExpired(new Date("2024-01-01T12:00:01Z"), now), false);
});

test("isLinkCodeUsed só é verdadeiro quando used_at não é nulo", () => {
    assert.equal(isLinkCodeUsed(null), false);
    assert.equal(isLinkCodeUsed(new Date()), true);
});

test("buildTelegramDeepLink usa TELEGRAM_BOT_USERNAME e aceita @ opcional", () => {
    const original = process.env.TELEGRAM_BOT_USERNAME;
    try {
        process.env.TELEGRAM_BOT_USERNAME = "@MeuBot";
        assert.equal(buildTelegramDeepLink("ABCD1234E"), "https://t.me/MeuBot?start=ABCD1234E");
    } finally {
        process.env.TELEGRAM_BOT_USERNAME = original;
    }
});

test("buildTelegramDeepLink lança erro de configuração quando a variável não está definida", () => {
    const original = process.env.TELEGRAM_BOT_USERNAME;
    try {
        delete process.env.TELEGRAM_BOT_USERNAME;
        assert.throws(() => buildTelegramDeepLink("ABCD1234E"), TelegramConfigurationError);
    } finally {
        process.env.TELEGRAM_BOT_USERNAME = original;
    }
});
