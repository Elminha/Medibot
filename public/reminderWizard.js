export const MAX_TIMES_PER_REMINDER = 12;
export const TIMES_PER_DAY_OPTIONS = [1, 2, 3, 4];
export const INTERVAL_HOURS_OPTIONS = [6, 8, 12];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BR_DATE_PATTERN = /^\d{2}\/\d{2}\/\d{4}$/;
const MINUTES_PER_DAY = 24 * 60;

// Índice = Date.getDay() (0 = domingo .. 6 = sábado); exibido em ordem Seg..Dom.
const WEEKDAY_SHORT_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
export const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function formatMinutesAsTime(totalMinutes) {
    const wrapped = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const hours = Math.floor(wrapped / 60);
    const minutes = wrapped % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Gera `count` horários igualmente espaçados em 24h a partir de `firstTime`, sempre
 * editáveis depois (isto só preenche um ponto de partida neutro: não é uma sugestão
 * de dose ou intervalo clínico).
 */
export function generateEvenlySpacedTimes(firstTime, count) {
    if (!TIME_PATTERN.test(firstTime) || !Number.isInteger(count) || count < 1 || count > MAX_TIMES_PER_REMINDER) {
        return [];
    }

    const [hour, minute] = firstTime.split(":").map(Number);
    const startMinutes = hour * 60 + minute;
    const stepMinutes = MINUTES_PER_DAY / count;
    const times = [];

    for (let index = 0; index < count; index += 1) {
        times.push(formatMinutesAsTime(startMinutes + stepMinutes * index));
    }

    return [...new Set(times)].sort();
}

/** "De X em X horas" reaproveita a mesma distribuição uniforme (count = 24 / X). */
export function generateIntervalTimes(firstTime, intervalHours) {
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24 || (24 % intervalHours) !== 0) {
        return [];
    }

    return generateEvenlySpacedTimes(firstTime, 24 / intervalHours);
}

/**
 * Modo "de X em X horas": ao editar o horário no índice `editedIndex` para `newTime`,
 * recalcula TODOS os outros mantendo o intervalo entre eles (sem mudar a ordem dos
 * campos). Só se usa neste modo — "1x a 4x" e "Escolher os horários" nunca chamam isto.
 */
export function recalculateIntervalTimes(times, editedIndex, newTime, intervalHours) {
    if (!Array.isArray(times) || !TIME_PATTERN.test(newTime) || !Number.isInteger(editedIndex)
        || editedIndex < 0 || editedIndex >= times.length || !Number.isInteger(intervalHours) || intervalHours < 1) {
        return Array.isArray(times) ? [...times] : [];
    }

    const [hour, minute] = newTime.split(":").map(Number);
    const baseMinutes = hour * 60 + minute;
    const stepMinutes = intervalHours * 60;
    return times.map((_, index) => formatMinutesAsTime(baseMinutes + (index - editedIndex) * stepMinutes));
}

export function isValidTimeString(value) {
    return typeof value === "string" && TIME_PATTERN.test(value);
}

/**
 * Máscara do campo de horário enquanto o usuário digita (ou cola): mantém só
 * dígitos (até 4) e insere ":" depois do 2º. Roda a cada tecla sobre o valor atual
 * do campo (que pode já ter ":"), então funciona igual para digitação e para colar
 * "13:10", "1310" ou "13h10".
 */
export function maskTimeTyping(rawValue) {
    const digits = (typeof rawValue === "string" ? rawValue : "").replace(/\D/g, "").slice(0, 4);
    if (digits.length <= 2) return digits;
    return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

/**
 * Normalização ao sair do campo (blur) ou Enter: completa horários parciais.
 * 1-2 dígitos = hora (minuto 00); 3 dígitos = 1 dígito de hora + 2 de minuto;
 * 4 dígitos = 2 de hora + 2 de minuto. Só formata ("HH:MM"); não valida o intervalo
 * (ver isValidTimeString) — "25:99" normaliza para "25:99", que fica inválido mas
 * com o formato certo para a mensagem de erro mostrar o valor digitado.
 */
export function normalizeTypedTime(rawValue) {
    const digits = (typeof rawValue === "string" ? rawValue : "").replace(/\D/g, "");
    if (!digits) return null;
    const [hourDigits, minuteDigits] = digits.length <= 2 ? [digits, "0"]
        : digits.length === 3 ? [digits.slice(0, 1), digits.slice(1)]
        : [digits.slice(0, 2), digits.slice(2, 4)];
    return `${hourDigits.padStart(2, "0")}:${minuteDigits.padStart(2, "0")}`;
}

/** ArrowUp/ArrowDown (±1 min) e PageUp/PageDown (±1h) do campo de horário, com volta em 23:59/00:00. */
export function stepTimeValue(value, deltaMinutes) {
    if (!Number.isInteger(deltaMinutes)) return value;
    const base = isValidTimeString(value) ? value : "00:00";
    const [hour, minute] = base.split(":").map(Number);
    const wrapped = (((hour * 60 + minute) + deltaMinutes) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    return formatMinutesAsTime(wrapped);
}

/**
 * Máscara do campo "Data de início" (DD/MM/AAAA) enquanto digita/cola: só dígitos
 * (até 8) e insere "/" depois do 2º e do 4º.
 */
export function maskDateTyping(rawValue) {
    const digits = (typeof rawValue === "string" ? rawValue : "").replace(/\D/g, "").slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

/** Valida "DD/MM/AAAA" como data de calendário real (rejeita 31/02, 30/02 etc.). */
export function isValidBrDate(value) {
    if (typeof value !== "string" || !BR_DATE_PATTERN.test(value)) return false;
    const [day, month, year] = value.split("/").map(Number);
    if (month < 1 || month > 12 || day < 1) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** "DD/MM/AAAA" validado -> "YYYY-MM-DD" (valor interno/API); null se inválido. */
export function brDateToIso(value) {
    if (!isValidBrDate(value)) return null;
    const [day, month, year] = value.split("/");
    return `${year}-${month}-${day}`;
}

export function formatWeekdaysSummary(weekdays) {
    if (!Array.isArray(weekdays) || weekdays.length === 0) {
        return "Todos os dias";
    }

    const unique = new Set(weekdays);
    return WEEKDAY_DISPLAY_ORDER
        .filter((day) => unique.has(day))
        .map((day) => WEEKDAY_SHORT_LABELS[day])
        .join(", ");
}

export function formatDateBr(dateKey) {
    if (typeof dateKey !== "string" || !DATE_PATTERN.test(dateKey)) {
        return "";
    }

    const [year, month, day] = dateKey.split("-");
    return `${day}/${month}/${year}`;
}

/** ends_on = starts_on + totalDays - 1 (inclusivo), em aritmética de calendário (sem fuso). */
export function computeEndsOn(startsOn, totalDays) {
    if (!DATE_PATTERN.test(startsOn) || !Number.isInteger(totalDays) || totalDays < 1) {
        return null;
    }

    const [year, month, day] = startsOn.split("-").map(Number);
    const end = new Date(Date.UTC(year, month - 1, day + totalDays - 1));
    return `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}`;
}

/** Inverso de computeEndsOn: quantos dias (inclusive) entre startsOn e endsOn. */
export function countDaysInclusive(startsOn, endsOn) {
    if (!DATE_PATTERN.test(startsOn) || !DATE_PATTERN.test(endsOn)) {
        return null;
    }

    const [startYear, startMonth, startDay] = startsOn.split("-").map(Number);
    const [endYear, endMonth, endDay] = endsOn.split("-").map(Number);
    const start = Date.UTC(startYear, startMonth - 1, startDay);
    const end = Date.UTC(endYear, endMonth - 1, endDay);
    const days = Math.round((end - start) / 86_400_000) + 1;
    return days >= 1 ? days : null;
}

/** Resumo de uma linha usado antes de salvar e na lista de lembretes. */
export function summarizeSchedule({ times, weekdays, endsOn, status }) {
    const timesLabel = Array.isArray(times) && times.length ? times.join(", ") : "sem horário definido";
    const daysLabel = formatWeekdaysSummary(weekdays);
    const durationLabel = endsOn ? `até ${formatDateBr(endsOn)}` : "sem data para terminar";
    const statusLabel = status === "paused" ? " (pausado)" : status === "ended" ? " (encerrado)" : "";

    return `${timesLabel} — ${daysLabel} — ${durationLabel}${statusLabel}`;
}

export function summarizeReminder({ medicationName, times, weekdays, endsOn, status }) {
    return `${medicationName} — ${summarizeSchedule({ times, weekdays, endsOn, status })}`;
}
