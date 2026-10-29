export const MAX_TIMES_PER_REMINDER = 12;
export const TIMES_PER_DAY_OPTIONS = [1, 2, 3, 4];
export const INTERVAL_HOURS_OPTIONS = [6, 8, 12];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
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
export function summarizeReminder({ medicationName, times, weekdays, endsOn, status }) {
    const timesLabel = Array.isArray(times) && times.length ? times.join(", ") : "sem horário definido";
    const daysLabel = formatWeekdaysSummary(weekdays);
    const durationLabel = endsOn ? `até ${formatDateBr(endsOn)}` : "sem data para terminar";
    const statusLabel = status === "paused" ? " (pausado)" : status === "ended" ? " (encerrado)" : "";

    return `${medicationName} — ${timesLabel} — ${daysLabel} — ${durationLabel}${statusLabel}`;
}
