export const REMINDER_TIME_ZONE = "America/Sao_Paulo";
const STORAGE_PREFIX = "medibot_delivered_reminders_v1";
const STORAGE_LIMIT = 500;
const MAX_CATCH_UP_MS = 5 * 60_000;

export function getSaoPauloParts(date) {
    const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: REMINDER_TIME_ZONE,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(date).map(({ type, value }) => [type, value]));
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: REMINDER_TIME_ZONE, weekday: "short" }).format(date);
    return {
        year: Number(values.year), month: Number(values.month), day: Number(values.day),
        hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
        weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday)
    };
}

function wallTimeToEpoch(year, month, day, hour, minute) {
    const target = Date.UTC(year, month - 1, day, hour, minute);
    let candidate = target;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const parts = getSaoPauloParts(new Date(candidate));
        const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
        const difference = target - represented;
        if (difference === 0) return candidate;
        candidate += difference;
    }
    return candidate;
}

export function getReminderOccurrence(reminder, date) {
    if (!reminder?.active || !Number.isSafeInteger(Number(reminder.id))) return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminder.time || "")) return null;
    const parts = getSaoPauloParts(date);
    if (reminder.frequency === "weekdays" && (parts.weekday === 0 || parts.weekday === 6)) return null;
    if (reminder.frequency !== "daily" && reminder.frequency !== "weekdays") return null;
    const [hour, minute] = reminder.time.split(":").map(Number);
    return {
        key: `${Number(reminder.id)}:${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${reminder.time}`,
        at: wallTimeToEpoch(parts.year, parts.month, parts.day, hour, minute)
    };
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
    constructor({ userId, notification, storage, onNavigate, now = () => new Date(), setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
        this.userId = String(userId);
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
            const occurrence = getReminderOccurrence(reminder, new Date(current));
            if (!occurrence || occurrence.at > current || current - occurrence.at > MAX_CATCH_UP_MS
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

export function startReminderSchedulerIfAllowed({ scheduler, userId, notification, isSecureContext, storage, reminders, onNavigate, now, setIntervalFn, clearIntervalFn }) {
    if (getNotificationAvailability({ notification, isSecureContext }) !== "enabled" || !Number.isSafeInteger(userId) || userId <= 0) {
        scheduler?.stop();
        return null;
    }
    if (scheduler && scheduler.userId !== String(userId)) scheduler.stop();
    const activeScheduler = scheduler?.userId === String(userId)
        ? scheduler
        : new ReminderNotificationScheduler({ userId, notification, storage, onNavigate, now, setIntervalFn, clearIntervalFn });
    activeScheduler.setReminders(reminders);
    activeScheduler.start();
    return activeScheduler;
}
