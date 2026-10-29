import test from "node:test";
import assert from "node:assert/strict";
import {
    brDateToIso,
    computeEndsOn,
    countDaysInclusive,
    formatDateBr,
    formatWeekdaysSummary,
    generateEvenlySpacedTimes,
    generateIntervalTimes,
    isValidBrDate,
    isValidTimeString,
    MAX_TIMES_PER_REMINDER,
    maskDateTyping,
    maskTimeTyping,
    normalizeTypedTime,
    recalculateIntervalTimes,
    stepTimeValue,
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

test("isValidTimeString aceita só 'HH:MM' com hora 00-23 e minuto 00-59", () => {
    assert.equal(isValidTimeString("00:00"), true);
    assert.equal(isValidTimeString("23:59"), true);
    assert.equal(isValidTimeString("24:00"), false);
    assert.equal(isValidTimeString("12:60"), false);
    assert.equal(isValidTimeString("9:30"), false);
    assert.equal(isValidTimeString(""), false);
    assert.equal(isValidTimeString(null), false);
});

test("maskTimeTyping insere ':' depois do 2º dígito e ignora o que não for dígito, digitando ou colando", () => {
    // digitando dígito por dígito (o campo chama a máscara com o valor atual a cada tecla)
    assert.equal(maskTimeTyping("1"), "1");
    assert.equal(maskTimeTyping("13"), "13");
    assert.equal(maskTimeTyping("131"), "13:1");
    assert.equal(maskTimeTyping("13:10"), "13:10"); // reaplicar sobre o próprio valor mascarado é idempotente
    // colar direto
    assert.equal(maskTimeTyping("13:10"), "13:10");
    assert.equal(maskTimeTyping("1310"), "13:10");
    assert.equal(maskTimeTyping("13h10"), "13:10");
    assert.equal(maskTimeTyping(""), "");
    assert.equal(maskTimeTyping("131099"), "13:10", "nunca passa de 4 dígitos (HHMM)");
});

test("normalizeTypedTime completa horários parciais ao sair do campo/Enter", () => {
    assert.equal(normalizeTypedTime("9"), "09:00");
    assert.equal(normalizeTypedTime("930"), "09:30");
    assert.equal(normalizeTypedTime("0930"), "09:30");
    assert.equal(normalizeTypedTime("13:10"), "13:10");
    assert.equal(normalizeTypedTime("1310"), "13:10");
    assert.equal(normalizeTypedTime(""), null);
    assert.equal(normalizeTypedTime(null), null);
});

test("normalizeTypedTime formata mas não valida o intervalo: hora>23 ou minuto>59 continuam fora do padrão", () => {
    const normalized = normalizeTypedTime("2599");
    assert.equal(normalized, "25:99");
    assert.equal(isValidTimeString(normalized), false, "a validação de intervalo é responsabilidade de isValidTimeString");
});

test("stepTimeValue: ArrowUp/Down ±1 minuto e PageUp/Down ±1 hora, com volta em 23:59/00:00", () => {
    assert.equal(stepTimeValue("10:30", 1), "10:31");
    assert.equal(stepTimeValue("10:30", -1), "10:29");
    assert.equal(stepTimeValue("23:59", 1), "00:00", "passa da meia-noite voltando para 00:00");
    assert.equal(stepTimeValue("00:00", -1), "23:59", "volta de 00:00 dá a última ocorrência do dia anterior");
    assert.equal(stepTimeValue("10:30", 60), "11:30");
    assert.equal(stepTimeValue("23:00", 60), "00:00");
    assert.equal(stepTimeValue("", 1), "00:01", "campo vazio/inválido parte de 00:00");
});

test("maskDateTyping insere '/' depois do 2º e do 4º dígito, digitando ou colando", () => {
    assert.equal(maskDateTyping("1"), "1");
    assert.equal(maskDateTyping("10"), "10");
    assert.equal(maskDateTyping("103"), "10/3");
    assert.equal(maskDateTyping("1003"), "10/03");
    assert.equal(maskDateTyping("10032"), "10/03/2");
    assert.equal(maskDateTyping("10032024"), "10/03/2024");
    assert.equal(maskDateTyping("10/03/2024"), "10/03/2024");
    assert.equal(maskDateTyping("100320241234"), "10/03/2024", "nunca passa de 8 dígitos (DDMMAAAA)");
});

test("isValidBrDate valida calendário real (rejeita 31/02, 30/02, mês/dia fora do intervalo)", () => {
    assert.equal(isValidBrDate("10/03/2024"), true);
    assert.equal(isValidBrDate("29/02/2024"), true, "2024 é bissexto");
    assert.equal(isValidBrDate("29/02/2023"), false, "2023 não é bissexto");
    assert.equal(isValidBrDate("31/02/2024"), false);
    assert.equal(isValidBrDate("00/03/2024"), false);
    assert.equal(isValidBrDate("10/13/2024"), false);
    assert.equal(isValidBrDate("2024-03-10"), false, "não aceita o formato ISO");
    assert.equal(isValidBrDate(""), false);
});

test("brDateToIso converte 'DD/MM/AAAA' validado para 'YYYY-MM-DD'; inválido devolve null", () => {
    assert.equal(brDateToIso("10/03/2024"), "2024-03-10");
    assert.equal(brDateToIso("31/02/2024"), null);
    assert.equal(brDateToIso("10-03-2024"), null);
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
