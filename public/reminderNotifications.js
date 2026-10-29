export const DEFAULT_REMINDER_TIME_ZONE = "America/Sao_Paulo";
const STORAGE_PREFIX = "medibot_delivered_reminders_v1";
const STORAGE_LIMIT = 500;
const MAX_CATCH_UP_MS = 5 * 60_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function getTimezoneParts(date, timezone) {
    const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(date).map(({ type, value }) => [type, value]));
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(date);
    const year = Number(values.year), month = Number(values.month), day = Number(values.day);
    return {
        year, month, day,
        hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
        weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday),
        dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    };
}

function wallTimeToEpoch(year, month, day, hour, minute, timezone) {
    const target = Date.UTC(year, month - 1, day, hour, minute);
    let candidate = target;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const parts = getTimezoneParts(new Date(candidate), timezone);
        const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
        const difference = target - represented;
        if (difference === 0) return candidate;
        candidate += difference;
    }
    return candidate;
}

/**
 * Todas as ocorrências de um lembrete (um ou mais horários) que caem no dia local
 * (fuso de `timezone`) de `date`, respeitando dias da semana e vigência (startsOn/
 * endsOn). Lista vazia = não dispara hoje (inativo, fora da vigência, horário
 * inválido ou dia não programado).
 */
export function getReminderOccurrences(reminder, date, timezone = DEFAULT_REMINDER_TIME_ZONE) {
    if (!reminder?.active || !Number.isSafeInteger(Number(reminder.id))) return [];

    const times = Array.isArray(reminder.times) ? reminder.times.filter((time) => TIME_PATTERN.test(time)) : [];
    if (!times.length) return [];

    const parts = getTimezoneParts(date, timezone);
    const weekdays = Array.isArray(reminder.weekdays) ? reminder.weekdays : [];
    if (weekdays.length > 0 && !weekdays.includes(parts.weekday)) return [];
    if (reminder.startsOn && parts.dateKey < reminder.startsOn) return [];
    if (reminder.endsOn && parts.dateKey > reminder.endsOn) return [];

    return times.map((time) => {
        const [hour, minute] = time.split(":").map(Number);
        return {
            key: `${Number(reminder.id)}:${parts.dateKey}T${time}`,
            at: wallTimeToEpoch(parts.year, parts.month, parts.day, hour, minute, timezone)
        };
    });
}

export function getNotificationAvailability({ notification, isSecureContext }) {
    if (!isSecureContext || !notification || typeof notification.requestPermission !== "function") return "blocked";
    if (notification.permission === "denied") return "blocked";
    return notification.permission === "granted" ? "enabled" : "disabled";
}

export async function fetchAuthenticatedReminders(fetcher, token) {
    if (!token) throw new Error("authentication-required");
    const response = await fetcher("/api/reminders", { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("reminders-load-failed");
    const data = await response.json();
    if (!data || !Array.isArray(data.reminders)) throw new Error("reminders-load-failed");
    return data.reminders;
}

function readDelivered(storage, userId) {
    try {
        const value = JSON.parse(storage?.getItem(`${STORAGE_PREFIX}:${userId}`) || "[]");
        return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
    } catch { return new Set(); }
}

export class ReminderNotificationScheduler {
    constructor({
        userId, timezone = DEFAULT_REMINDER_TIME_ZONE, notification, storage, onNavigate,
        now = () => new Date(), setIntervalFn = setInterval, clearIntervalFn = clearInterval
    }) {
        this.userId = String(userId);
        this.timezone = timezone;
        this.notification = notification;
        this.storage = storage;
        this.onNavigate = onNavigate;
        this.now = now;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.reminders = [];
        this.delivered = readDelivered(storage, this.userId);
        this.pending = new Set();
        this.timer = null;
        this.lastCheck = null;
    }

    setReminders(reminders) { this.reminders = reminders.filter((reminder) => reminder?.active === true); }

    start() {
        if (this.timer !== null) return;
        if (this.lastCheck === null) this.lastCheck = this.now().getTime() - MAX_CATCH_UP_MS;
        this.check();
        this.timer = this.setIntervalFn(() => this.check(), 15_000);
    }

    stop() {
        if (this.timer !== null) this.clearIntervalFn(this.timer);
        this.timer = null;
        this.lastCheck = null;
    }

    handleVisibilityChange(isVisible) {
        if (!isVisible) {
            if (this.timer !== null) this.clearIntervalFn(this.timer);
            this.timer = null;
            return;
        }
        if (this.lastCheck === null) this.lastCheck = this.now().getTime() - MAX_CATCH_UP_MS;
        this.check();
        if (this.timer === null) this.timer = this.setIntervalFn(() => this.check(), 15_000);
    }

    check() {
        const current = this.now().getTime();
        const previous = this.lastCheck ?? current - 60_000;
        this.lastCheck = current;
        for (const reminder of this.reminders) {
            for (const occurrence of getReminderOccurrences(reminder, new Date(current), this.timezone)) {
                if (occurrence.at > current || current - occurrence.at > MAX_CATCH_UP_MS
                    || (occurrence.at <= previous && !this.pending.has(occurrence.key)) || this.delivered.has(occurrence.key)) continue;
                try {
                    const notification = new this.notification("MediBot", {
                        body: "Está na hora de conferir seu lembrete de medicamento.",
                        tag: `medibot-${occurrence.key}`
                    });
                    notification.onclick = () => {
                        this.onNavigate();
                        notification.close?.();
                    };
                    this.delivered.add(occurrence.key);
                    this.pending.delete(occurrence.key);
                    try {
                        const keys = [...this.delivered].slice(-STORAGE_LIMIT);
                        this.delivered = new Set(keys);
                        this.storage?.setItem(`${STORAGE_PREFIX}:${this.userId}`, JSON.stringify(keys));
                    } catch { /* A memória da página ainda impede duplicatas durante esta sessão. */ }
                } catch {
                    this.pending.add(occurrence.key);
                    /* Uma falha ao criar a notificação não é registrada como entrega. */
                }
            }
        }
    }
}

export function startReminderSchedulerIfAllowed({
    scheduler, userId, timezone = DEFAULT_REMINDER_TIME_ZONE, notification, isSecureContext, storage,
    reminders, onNavigate, now, setIntervalFn, clearIntervalFn
}) {
    if (getNotificationAvailability({ notification, isSecureContext }) !== "enabled" || !Number.isSafeInteger(userId) || userId <= 0) {
        scheduler?.stop();
        return null;
    }
    const matchesCurrent = scheduler?.userId === String(userId) && scheduler?.timezone === timezone;
    if (scheduler && !matchesCurrent) scheduler.stop();
    const activeScheduler = matchesCurrent
        ? scheduler
        : new ReminderNotificationScheduler({ userId, timezone, notification, storage, onNavigate, now, setIntervalFn, clearIntervalFn });
    activeScheduler.setReminders(reminders);
    activeScheduler.start();
    return activeScheduler;
}
