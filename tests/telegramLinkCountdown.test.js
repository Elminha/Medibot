import test from "node:test";
import assert from "node:assert/strict";
import {
    COUNTDOWN_URGENT_THRESHOLD_MS,
    COUNTDOWN_CRITICAL_THRESHOLD_MS,
    formatCountdown,
    getCountdownLevel,
    getRemainingMs,
    isCountdownExpired,
    isCountdownUrgent,
    parseStoredLinkCode,
    TelegramLinkCountdownTimer
} from "../public/telegramLinkCountdown.js";

/** Scheduler falso: registra os intervalos "ativos" sem usar temporizadores reais. */
function makeFakeScheduler() {
    let nextId = 1;
    const active = new Map();
    const clearedIds = [];
    return {
        setIntervalFn: (callback) => {
            const id = nextId++;
            active.set(id, callback);
            return id;
        },
        clearIntervalFn: (id) => {
            active.delete(id);
            clearedIds.push(id);
        },
        activeCount: () => active.size,
        clearedIds
    };
}

test("getRemainingMs calcula pela diferença entre expiresAt e now, não por contador", () => {
    const now = Date.parse("2024-01-01T12:00:00Z");
    assert.equal(getRemainingMs("2024-01-01T12:05:00Z", now), 5 * 60_000);
    assert.equal(getRemainingMs("2024-01-01T11:59:00Z", now), -60_000);
});

test("getRemainingMs devolve NaN para expiresAt inválido", () => {
    assert.ok(Number.isNaN(getRemainingMs("data-invalida", Date.now())));
    assert.ok(Number.isNaN(getRemainingMs(undefined, Date.now())));
});

test("isCountdownExpired: positivo não expirou, zero e negativo expiraram, NaN conta como expirado", () => {
    assert.equal(isCountdownExpired(1), false);
    assert.equal(isCountdownExpired(0), true);
    assert.equal(isCountdownExpired(-1), true);
    assert.equal(isCountdownExpired(NaN), true);
});

test("formatCountdown formata MM:SS e nunca fica negativo", () => {
    assert.equal(formatCountdown(10 * 60_000), "10:00");
    assert.equal(formatCountdown(65_000), "01:05");
    assert.equal(formatCountdown(500), "00:01");
    assert.equal(formatCountdown(0), "00:00");
    assert.equal(formatCountdown(-5000), "00:00");
    assert.equal(formatCountdown(NaN), "00:00");
});

test("isCountdownUrgent: true só nos últimos 60s antes de expirar, exclui o próprio zero", () => {
    assert.equal(isCountdownUrgent(COUNTDOWN_URGENT_THRESHOLD_MS), true); // no limite exato
    assert.equal(isCountdownUrgent(COUNTDOWN_URGENT_THRESHOLD_MS + 1), false);
    assert.equal(isCountdownUrgent(1), true);
    assert.equal(isCountdownUrgent(0), false);
    assert.equal(isCountdownUrgent(-1000), false);
    assert.equal(isCountdownUrgent(NaN), false);
});

test("getCountdownLevel: normal acima de 60s, urgent de 60s a 11s, critical nos últimos 10s", () => {
    assert.equal(getCountdownLevel(COUNTDOWN_URGENT_THRESHOLD_MS + 1), "normal"); // 61s
    assert.equal(getCountdownLevel(COUNTDOWN_URGENT_THRESHOLD_MS), "urgent"); // 60s, no limite exato
    assert.equal(getCountdownLevel(11_000), "urgent"); // 11s
    assert.equal(getCountdownLevel(COUNTDOWN_CRITICAL_THRESHOLD_MS), "critical"); // 10s, no limite exato
    assert.equal(getCountdownLevel(1_000), "critical"); // 1s
    assert.equal(getCountdownLevel(0), "critical");
    assert.equal(getCountdownLevel(-1_000), "critical");
    assert.equal(getCountdownLevel(NaN), "critical");
});

test("parseStoredLinkCode aceita um objeto válido, com e sem telegramLink", () => {
    assert.deepEqual(
        parseStoredLinkCode(JSON.stringify({ code: "ABC123XYZ", expiresAt: "2024-01-01T12:10:00Z" })),
        { code: "ABC123XYZ", expiresAt: "2024-01-01T12:10:00Z", telegramLink: undefined }
    );
    assert.deepEqual(
        parseStoredLinkCode(JSON.stringify({ code: "ABC123XYZ", expiresAt: "2024-01-01T12:10:00Z", telegramLink: "https://t.me/bot?start=ABC123XYZ" })),
        { code: "ABC123XYZ", expiresAt: "2024-01-01T12:10:00Z", telegramLink: "https://t.me/bot?start=ABC123XYZ" }
    );
});

test("parseStoredLinkCode rejeita JSON corrompido e valores malformados", () => {
    const malformed = [
        null,
        undefined,
        "",
        "{não é json",
        "null",
        "42",
        "[]",
        JSON.stringify({}),
        JSON.stringify({ code: "", expiresAt: "2024-01-01T12:10:00Z" }),
        JSON.stringify({ code: "   ", expiresAt: "2024-01-01T12:10:00Z" }),
        JSON.stringify({ code: 123, expiresAt: "2024-01-01T12:10:00Z" }),
        JSON.stringify({ code: "ABC123XYZ" }),
        JSON.stringify({ code: "ABC123XYZ", expiresAt: "data-invalida" }),
        JSON.stringify({ code: "ABC123XYZ", expiresAt: 12345 })
    ];

    for (const value of malformed) {
        assert.equal(parseStoredLinkCode(value), null, `deveria rejeitar: ${JSON.stringify(value)}`);
    }
});

test("TelegramLinkCountdownTimer: start() nunca deixa mais de um setInterval ativo", () => {
    const scheduler = makeFakeScheduler();
    const now = Date.parse("2024-01-01T12:00:00Z");
    const timer = new TelegramLinkCountdownTimer({
        now: () => now,
        setIntervalFn: scheduler.setIntervalFn,
        clearIntervalFn: scheduler.clearIntervalFn
    });

    timer.start("2024-01-01T12:10:00Z");
    assert.equal(scheduler.activeCount(), 1);

    timer.start("2024-01-01T12:20:00Z"); // ex.: gerar outro código
    assert.equal(scheduler.activeCount(), 1); // nunca dois ativos ao mesmo tempo
    assert.equal(scheduler.clearedIds.length, 1); // o intervalo antigo foi limpo antes do novo
});

test("TelegramLinkCountdownTimer: tick() para o timer e chama onExpired quando o prazo já passou", () => {
    const scheduler = makeFakeScheduler();
    const now = Date.parse("2024-01-01T12:10:01Z");
    let expiredCalls = 0;
    const timer = new TelegramLinkCountdownTimer({
        now: () => now,
        setIntervalFn: scheduler.setIntervalFn,
        clearIntervalFn: scheduler.clearIntervalFn,
        onExpired: () => { expiredCalls += 1; }
    });

    timer.start("2024-01-01T12:10:00Z"); // já vencido no momento do start
    assert.equal(expiredCalls, 1);
    assert.equal(timer.isRunning(), false);
    assert.equal(scheduler.activeCount(), 0);
});

test("TelegramLinkCountdownTimer: start() reinicia a contagem para o novo expiresAt (gerar outro código)", () => {
    const scheduler = makeFakeScheduler();
    const now = Date.parse("2024-01-01T12:00:00Z");
    const ticks = [];
    const timer = new TelegramLinkCountdownTimer({
        now: () => now,
        setIntervalFn: scheduler.setIntervalFn,
        clearIntervalFn: scheduler.clearIntervalFn,
        onTick: (remainingMs) => ticks.push(remainingMs)
    });

    timer.start("2024-01-01T12:05:00Z");
    timer.start("2024-01-01T12:10:00Z");

    assert.deepEqual(ticks, [5 * 60_000, 10 * 60_000]);
});

test("TelegramLinkCountdownTimer: stop() encerra o timer manualmente (ex.: vínculo concluído)", () => {
    const scheduler = makeFakeScheduler();
    const timer = new TelegramLinkCountdownTimer({
        now: () => Date.parse("2024-01-01T12:00:00Z"),
        setIntervalFn: scheduler.setIntervalFn,
        clearIntervalFn: scheduler.clearIntervalFn
    });

    timer.start("2024-01-01T12:10:00Z");
    timer.stop();

    assert.equal(timer.isRunning(), false);
    assert.equal(scheduler.activeCount(), 0);

    // depois do stop(), o expiresAt foi esquecido: tick() não deve fazer nada (nem lançar).
    timer.tick();
});
