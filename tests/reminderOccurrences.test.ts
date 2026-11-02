import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
    getOccurrencesInWindow,
    getReminderOccurrences,
    getTimezoneParts,
    type OccurrenceReminder
} from "../src/services/reminderOccurrences.ts";

interface Fixture {
    description: string;
    reminder: OccurrenceReminder;
    date: string;
    timezone: string;
    expected: Array<{ key: string; at: number }>;
}

const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "reminderOccurrences.json");
const fixtures: Fixture[] = JSON.parse(readFileSync(fixturesPath, "utf8"));

test("fixtures compartilhadas: getReminderOccurrences (lado TypeScript)", () => {
    for (const fixture of fixtures) {
        const result = getReminderOccurrences(fixture.reminder, new Date(fixture.date), fixture.timezone);
        assert.deepEqual(result, fixture.expected, fixture.description);
    }
});

test("getTimezoneParts interpreta horário e dia no fuso informado, não no fuso do servidor", () => {
    const instant = new Date("2024-01-08T13:30:00.000Z");
    assert.deepEqual(
        getTimezoneParts(instant, "America/Sao_Paulo"),
        { year: 2024, month: 1, day: 8, hour: 10, minute: 30, second: 0, weekday: 1, dateKey: "2024-01-08" }
    );
});

function reminder(overrides: Partial<OccurrenceReminder> & { id: number }): OccurrenceReminder {
    return {
        active: true,
        times: ["08:00"],
        weekdays: [],
        startsOn: null,
        endsOn: null,
        ...overrides
    };
}

test("getOccurrencesInWindow: ocorrência dentro da janela de 5 minutos é 'due'", () => {
    // 08:00 local (2024-01-10) = 2024-01-10T11:00:00.000Z (UTC-3, sem horário de verão).
    const occurrenceAt = new Date("2024-01-10T11:00:00.000Z").getTime();
    const now = new Date(occurrenceAt + 2 * 60_000);
    const result = getOccurrencesInWindow(reminder({ id: 1 }), now, 5 * 60_000);
    assert.equal(result.due.length, 1);
    assert.equal(result.due[0].at, occurrenceAt);
    assert.equal(result.expired.length, 0);
});

test("getOccurrencesInWindow: limite exato 'agora' (at === now) é due", () => {
    const occurrenceAt = new Date("2024-01-10T11:00:00.000Z").getTime();
    const now = new Date(occurrenceAt);
    const result = getOccurrencesInWindow(reminder({ id: 1 }), now, 5 * 60_000);
    assert.equal(result.due.length, 1);
});

test("getOccurrencesInWindow: limite exato 'agora - windowMs' NÃO entra (janela aberta no início)", () => {
    const occurrenceAt = new Date("2024-01-10T11:00:00.000Z").getTime();
    const now = new Date(occurrenceAt + 5 * 60_000);
    const result = getOccurrencesInWindow(reminder({ id: 1 }), now, 5 * 60_000);
    assert.equal(result.due.length, 0, "exatamente no limite inferior deve contar como expirado, não devido");
    assert.equal(result.expired.length, 1);
});

test("getOccurrencesInWindow: ocorrência futura (ainda não chegou a hora) é ignorada por completo", () => {
    const occurrenceAt = new Date("2024-01-10T11:00:00.000Z").getTime();
    const now = new Date(occurrenceAt - 60_000);
    const result = getOccurrencesInWindow(reminder({ id: 1 }), now, 5 * 60_000);
    assert.equal(result.due.length, 0);
    assert.equal(result.expired.length, 0);
});

test("getOccurrencesInWindow: ocorrência vencida há mais que a janela é 'expired'", () => {
    const occurrenceAt = new Date("2024-01-10T11:00:00.000Z").getTime();
    const now = new Date(occurrenceAt + 10 * 60_000);
    const result = getOccurrencesInWindow(reminder({ id: 1 }), now, 5 * 60_000);
    assert.equal(result.due.length, 0);
    assert.equal(result.expired.length, 1);
});

test("getOccurrencesInWindow: virada de meia-noite — ocorrência de 23:58 de 'ontem' (dia local já virou) ainda cabe na janela", () => {
    // 23:58 local em 2024-01-10 = 2024-01-11T02:58:00.000Z.
    const occurrenceAt = new Date("2024-01-11T02:58:00.000Z").getTime();
    // "agora" é 00:02 local do dia seguinte — já virou o dia local, mas ainda dentro da
    // janela de 5 min (gap de 4 min).
    const now = new Date(occurrenceAt + 4 * 60_000);
    const reminderThatCrossesMidnight = reminder({ id: 20, times: ["23:58"] });
    const result = getOccurrencesInWindow(reminderThatCrossesMidnight, now, 5 * 60_000);
    assert.equal(result.due.length, 1);
    assert.equal(result.due[0].at, occurrenceAt);
    assert.equal(result.expired.length, 0);
});

test("getOccurrencesInWindow: várias ocorrências (horários diferentes) no mesmo lembrete, todas due", () => {
    const base = new Date("2024-01-10T11:00:00.000Z").getTime(); // 08:00 local
    const now = new Date(base);
    const multiTimeReminder = reminder({ id: 30, times: ["08:00"] });
    const result = getOccurrencesInWindow(multiTimeReminder, now, 5 * 60_000);
    assert.equal(result.due.length, 1);
});

test("getOccurrencesInWindow: lembrete inativo nunca aparece", () => {
    const occurrenceAt = new Date("2024-01-10T11:00:00.000Z").getTime();
    const now = new Date(occurrenceAt);
    const result = getOccurrencesInWindow(reminder({ id: 1, active: false }), now, 5 * 60_000);
    assert.equal(result.due.length, 0);
    assert.equal(result.expired.length, 0);
});
