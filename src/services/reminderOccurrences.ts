/**
 * Porta em TypeScript das regras puras de ocorrência de public/reminderNotifications.js
 * (getTimezoneParts/getReminderOccurrences), para o despachante do servidor reaproveitar
 * exatamente a mesma regra que o navegador usa. É uma PORTA, não um import direto: as
 * duas implementações são mantidas em sincronia por testes que rodam as MESMAS fixtures
 * (tests/fixtures/reminderOccurrences.json) contra os dois lados — ver
 * tests/reminderOccurrences.test.ts e o bloco correspondente em
 * tests/reminderNotifications.test.js. Qualquer mudança de regra precisa ser replicada
 * manualmente nos dois arquivos.
 */

export const DEFAULT_REMINDER_TIME_ZONE = "America/Sao_Paulo";

export interface OccurrenceReminder {
    id: number | string;
    active: boolean;
    times: string[] | null | undefined;
    weekdays: number[] | null | undefined;
    startsOn: string | null | undefined;
    endsOn: string | null | undefined;
}

export interface ReminderOccurrence {
    key: string;
    at: number;
}

interface TimezoneParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    weekday: number;
    dateKey: string;
}

const WEEKDAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function getTimezoneParts(date: Date, timezone: string): TimezoneParts {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
    }).formatToParts(date);
    const lookup = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const weekdayName = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(date);
    const year = Number(lookup.year);
    const month = Number(lookup.month);
    const day = Number(lookup.day);

    return {
        year,
        month,
        day,
        hour: Number(lookup.hour),
        minute: Number(lookup.minute),
        second: Number(lookup.second),
        weekday: WEEKDAY_SHORT_NAMES.indexOf(weekdayName),
        dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    };
}

/** Aceita "HH:MM" ou "HH:MM:SS" (coluna TIME bruta do Postgres); null se inválido. */
function normalizeTimeString(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)/);
    return match ? `${match[1]}:${match[2]}` : null;
}

/**
 * Aceita "YYYY-MM-DD", um Date (lido via getters UTC — uma coluna DATE não tem fuso) ou
 * uma string ISO com horário. null para qualquer outra coisa (ex.: ausente).
 */
function normalizeDateKey(value: unknown): string | null {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            return null;
        }
        return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
    }
    if (typeof value === "string" && value.length >= 10) {
        return value.slice(0, 10);
    }
    return null;
}

function wallTimeToEpoch(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    timezone: string
): number {
    const target = Date.UTC(year, month - 1, day, hour, minute);
    let candidate = target;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const parts = getTimezoneParts(new Date(candidate), timezone);
        const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
        const difference = target - represented;
        if (difference === 0) {
            return candidate;
        }
        candidate += difference;
    }
    return candidate;
}

/**
 * Todas as ocorrências de um lembrete (um ou mais horários) que caem no dia local
 * (fuso de `timezone`) de `date`, respeitando dias da semana e vigência (startsOn/
 * endsOn, ambos inclusivos). Lista vazia = não dispara nesse dia (inativo, fora da
 * vigência, horário inválido ou dia não programado).
 */
export function getReminderOccurrences(
    reminder: OccurrenceReminder,
    date: Date,
    timezone: string = DEFAULT_REMINDER_TIME_ZONE
): ReminderOccurrence[] {
    if (!reminder?.active || !Number.isSafeInteger(Number(reminder.id))) {
        return [];
    }

    const times = Array.isArray(reminder.times)
        ? [...new Set(reminder.times.map(normalizeTimeString).filter((value): value is string => Boolean(value)))]
        : [];
    if (!times.length) {
        return [];
    }

    const parts = getTimezoneParts(date, timezone);
    const weekdays = Array.isArray(reminder.weekdays) ? reminder.weekdays : [];
    if (weekdays.length > 0 && !weekdays.includes(parts.weekday)) {
        return [];
    }
    const startsOn = normalizeDateKey(reminder.startsOn);
    const endsOn = normalizeDateKey(reminder.endsOn);
    if (startsOn && parts.dateKey < startsOn) {
        return [];
    }
    if (endsOn && parts.dateKey > endsOn) {
        return [];
    }

    return times.map((time) => {
        const [hour, minute] = time.split(":").map(Number);
        return {
            key: `${Number(reminder.id)}:${parts.dateKey}T${time}`,
            at: wallTimeToEpoch(parts.year, parts.month, parts.day, hour, minute, timezone)
        };
    });
}

export interface WindowedOccurrences {
    due: ReminderOccurrence[];
    expired: ReminderOccurrence[];
}

/**
 * Específico do despachante do servidor (sem equivalente no navegador, que tem seu
 * próprio controle de estado/pendências em ReminderNotificationScheduler): separa as
 * ocorrências de um lembrete em "due" (vencidas dentro da janela de tolerância,
 * `(agora - windowMs, agora]`) e "expired" (vencidas há um pouco mais que isso, até
 * `windowMs` adicionais — só para registrar um atraso do cron; além disso a ocorrência
 * é ignorada por completo, sem gerar ruído). Olha o dia local de `now` e o dia local
 * anterior, para cobrir corretamente a virada da meia-noite; sem esse limite superior
 * no bucket "expired", a MESMA ocorrência de "ontem" de um lembrete diário comum (que
 * está sempre a ~24h de distância) apareceria como vencida em toda execução.
 */
export function getOccurrencesInWindow(
    reminder: OccurrenceReminder,
    now: Date,
    windowMs: number,
    timezone: string = DEFAULT_REMINDER_TIME_ZONE,
    expiredWindowMs: number = windowMs
): WindowedOccurrences {
    const nowMs = now.getTime();
    const due: ReminderOccurrence[] = [];
    const expired: ReminderOccurrence[] = [];
    const seenKeys = new Set<string>();

    for (const dayOffsetMs of [0, -86_400_000]) {
        const occurrences = getReminderOccurrences(reminder, new Date(nowMs + dayOffsetMs), timezone);
        for (const occurrence of occurrences) {
            if (seenKeys.has(occurrence.key)) {
                continue;
            }
            seenKeys.add(occurrence.key);

            if (occurrence.at > nowMs) {
                continue;
            }
            if (occurrence.at > nowMs - windowMs) {
                due.push(occurrence);
            } else if (occurrence.at >= nowMs - windowMs - expiredWindowMs) {
                expired.push(occurrence);
            }
        }
    }

    return { due, expired };
}
