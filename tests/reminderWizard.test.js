import test from "node:test";
import assert from "node:assert/strict";
import {
    computeEndsOn,
    countDaysInclusive,
    formatDateBr,
    formatWeekdaysSummary,
    generateEvenlySpacedTimes,
    generateIntervalTimes,
    MAX_TIMES_PER_REMINDER,
    recalculateIntervalTimes,
    summarizeReminder,
    summarizeSchedule
} from "../public/reminderWizard.js";

test("1x a 4x por dia distribui os horários igualmente a partir do primeiro horário", () => {
    assert.deepEqual(generateEvenlySpacedTimes("08:00", 1), ["08:00"]);
    assert.deepEqual(generateEvenlySpacedTimes("08:00", 2), ["08:00", "20:00"]);
    assert.deepEqual(generateEvenlySpacedTimes("08:00", 3), ["00:00", "08:00", "16:00"]);
    assert.deepEqual(generateEvenlySpacedTimes("08:00", 4), ["02:00", "08:00", "14:00", "20:00"]);
});

test("de X em X horas gera a mesma distribuição que Nx equivalente", () => {
    assert.deepEqual(generateIntervalTimes("08:00", 12), generateEvenlySpacedTimes("08:00", 2));
    assert.deepEqual(generateIntervalTimes("08:00", 8), generateEvenlySpacedTimes("08:00", 3));
    assert.deepEqual(generateIntervalTimes("08:00", 6), generateEvenlySpacedTimes("08:00", 4));
});

test("intervalo que não divide 24h igualmente é rejeitado", () => {
    assert.deepEqual(generateIntervalTimes("08:00", 5), []);
    assert.deepEqual(generateIntervalTimes("08:00", 0), []);
});

test("entradas inválidas (horário malformado, contagem fora do limite) não geram horário", () => {
    assert.deepEqual(generateEvenlySpacedTimes("8:00", 2), []);
    assert.deepEqual(generateEvenlySpacedTimes("08:00", 0), []);
    assert.deepEqual(generateEvenlySpacedTimes("08:00", MAX_TIMES_PER_REMINDER + 1), []);
});

test("recalculateIntervalTimes mantém o intervalo ao editar qualquer horário, sem reordenar os campos", () => {
    assert.deepEqual(recalculateIntervalTimes(["08:00", "14:00", "20:00"], 1, "15:00", 6), ["09:00", "15:00", "21:00"]);
    assert.deepEqual(recalculateIntervalTimes(["08:00", "20:00"], 0, "22:00", 12), ["22:00", "10:00"]);
    // edita o primeiro horário de um "de 8 em 8" e os demais acompanham, com wrap à meia-noite
    assert.deepEqual(recalculateIntervalTimes(["08:00", "16:00", "00:00"], 0, "22:00", 8), ["22:00", "06:00", "14:00"]);
});

test("recalculateIntervalTimes com entrada inválida devolve os horários originais, sem quebrar", () => {
    assert.deepEqual(recalculateIntervalTimes(["08:00", "14:00"], 0, "25:99", 6), ["08:00", "14:00"]);
    assert.deepEqual(recalculateIntervalTimes(["08:00", "14:00"], 5, "09:00", 6), ["08:00", "14:00"]);
});

test("summarizeSchedule é o summarizeReminder sem o nome do medicamento", () => {
    const schedule = { times: ["08:00", "20:00"], weekdays: [1, 2, 3, 4, 5], endsOn: "2024-03-16", status: "paused" };
    assert.equal(summarizeSchedule(schedule), "08:00, 20:00 — Seg, Ter, Qua, Qui, Sex — até 16/03/2024 (pausado)");
    assert.equal(summarizeReminder({ medicationName: "Losartana", ...schedule }), `Losartana — ${summarizeSchedule(schedule)}`);
});

test("formatWeekdaysSummary: vazio é 'Todos os dias'; dias específicos saem em ordem Seg..Dom", () => {
    assert.equal(formatWeekdaysSummary([]), "Todos os dias");
    assert.equal(formatWeekdaysSummary([0, 1, 5]), "Seg, Sex, Dom");
    assert.equal(formatWeekdaysSummary([1, 2, 3, 4, 5]), "Seg, Ter, Qua, Qui, Sex");
});

test("formatDateBr converte YYYY-MM-DD para DD/MM/YYYY e rejeita entrada inválida", () => {
    assert.equal(formatDateBr("2024-03-10"), "10/03/2024");
    assert.equal(formatDateBr(null), "");
    assert.equal(formatDateBr("10/03/2024"), "");
});

test("computeEndsOn soma dias de calendário (inclusivo), sem depender de fuso", () => {
    assert.equal(computeEndsOn("2024-03-10", 1), "2024-03-10");
    assert.equal(computeEndsOn("2024-03-10", 7), "2024-03-16");
    assert.equal(computeEndsOn("2024-02-27", 3), "2024-02-29");
    assert.equal(computeEndsOn("2024-03-10", 0), null);
});

test("countDaysInclusive é o inverso de computeEndsOn", () => {
    assert.equal(countDaysInclusive("2024-03-10", "2024-03-10"), 1);
    assert.equal(countDaysInclusive("2024-03-10", "2024-03-16"), 7);
    assert.equal(countDaysInclusive("2024-02-27", "2024-02-29"), 3);
    assert.equal(countDaysInclusive("2024-03-16", "2024-03-10"), null);
    for (const [startsOn, days] of [["2024-03-10", 7], ["2024-02-27", 3], ["2023-12-30", 5]]) {
        assert.equal(countDaysInclusive(startsOn, computeEndsOn(startsOn, days)), days);
    }
});

test("summarizeReminder monta a linha de resumo usada antes de salvar e na lista", () => {
    assert.equal(
        summarizeReminder({ medicationName: "Dipirona", times: ["08:00", "20:00"], weekdays: [], endsOn: null, status: "active" }),
        "Dipirona — 08:00, 20:00 — Todos os dias — sem data para terminar"
    );
    assert.equal(
        summarizeReminder({
            medicationName: "Losartana", times: ["09:00"], weekdays: [1, 2, 3, 4, 5], endsOn: "2024-03-16", status: "paused"
        }),
        "Losartana — 09:00 — Seg, Ter, Qua, Qui, Sex — até 16/03/2024 (pausado)"
    );
});
