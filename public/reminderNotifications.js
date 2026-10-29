export const DEFAULT_REMINDER_TIME_ZONE = "America/Sao_Paulo";
const STORAGE_PREFIX = "medibot_delivered_reminders_v1";
const STORAGE_LIMIT = 500;
const MAX_CATCH_UP_MS = 5 * 60_000;
const NOTIFICATIONS_UNSUPPORTED_STORAGE_KEY = "medibotNotificationsUnsupported";

/**
 * Casos conhecidos em que `new Notification()` não funciona mesmo com permissão
 * concedida: Chrome Android exige Service Worker (showNotification, não o
 * construtor), e Safari/iOS só libera notificação de site instalado como app. Não
 * precisa ser exaustivo — é só para abrir direto no estado "sem suporte" (ver
 * reminderNotificationsUnsupportedFlag abaixo), sem a volta de clicar "Ativar
 * notificações" e descobrir que não funciona.
 */
export function isLikelyUnsupportedNotificationUserAgent(userAgent) {
    return typeof userAgent === "string" && /android|iphone|ipad|ipod/i.test(userAgent);
}

/**
 * localStorage já é isolado por origem, então não há "chave por origem" além do
 * próprio localStorage do navegador: isso só embrulha getItem/setItem/removeItem
 * em try/catch (localStorage pode lançar em modo privado em alguns navegadores).
 */
export function readNotificationsUnsupportedFlag(storage) {
    try {
        return storage?.getItem(NOTIFICATIONS_UNSUPPORTED_STORAGE_KEY) === "1";
    } catch {
        return false;
    }
}

export function writeNotificationsUnsupportedFlag(storage) {
    try {
        storage?.setItem(NOTIFICATIONS_UNSUPPORTED_STORAGE_KEY, "1");
    } catch {
        /* Sem localStorage disponível: só não persiste entre recargas desta sessão. */
    }
}

export function clearNotificationsUnsupportedFlag(storage) {
    try {
        storage?.removeItem(NOTIFICATIONS_UNSUPPORTED_STORAGE_KEY);
    } catch {
        /* idem */
    }
}

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

/**
 * Normaliza um horário para "HH:MM", aceitando também "HH:MM:SS" (é o formato bruto
 * de uma coluna TIME do Postgres, caso algum dia volte a sair sem to_char na API).
 * Retorna null para qualquer coisa que não comece com um horário válido.
 */
function normalizeTimeString(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)/);
    return match ? `${match[1]}:${match[2]}` : null;
}

/**
 * Normaliza uma data para "YYYY-MM-DD", aceitando também um `Date` (é o que o
 * node-pg devolve para uma coluna DATE sem to_char: meia-noite UTC do dia
 * armazenado) ou uma string ISO com horário ("YYYY-MM-DDTHH:MM:SS.sssZ"). Usa os
 * getters UTC do Date — nunca os locais — porque uma coluna DATE não tem fuso: ler
 * com getDate()/getMonth() locais deslocaria um dia para fusos negativos (ex.: o
 * processo Node rodando em UTC-3 leria "2026-10-28" para um "2026-10-29" salvo).
 */
function normalizeDateKey(value) {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
    }
    if (typeof value === "string" && value.length >= 10) return value.slice(0, 10);
    return null;
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

    const times = Array.isArray(reminder.times)
        ? [...new Set(reminder.times.map(normalizeTimeString).filter(Boolean))]
        : [];
    if (!times.length) return [];

    const parts = getTimezoneParts(date, timezone);
    const weekdays = Array.isArray(reminder.weekdays) ? reminder.weekdays : [];
    if (weekdays.length > 0 && !weekdays.includes(parts.weekday)) return [];
    const startsOn = normalizeDateKey(reminder.startsOn);
    const endsOn = normalizeDateKey(reminder.endsOn);
    if (startsOn && parts.dateKey < startsOn) return [];
    if (endsOn && parts.dateKey > endsOn) return [];

    return times.map((time) => {
        const [hour, minute] = time.split(":").map(Number);
        return {
            key: `${Number(reminder.id)}:${parts.dateKey}T${time}`,
            at: wallTimeToEpoch(parts.year, parts.month, parts.day, hour, minute, timezone)
        };
    });
}

/**
 * Próxima ocorrência futura entre todos os lembretes, podendo ser em um dia
 * seguinte (olha até `lookaheadDays` dias para a frente — suficiente para cobrir
 * qualquer combinação de dias da semana). null se não houver nenhuma dentro da
 * janela (ex.: nenhum lembrete ativo, ou todos já encerrados).
 */
export function getNextOccurrence(reminders, now, timezone = DEFAULT_REMINDER_TIME_ZONE, lookaheadDays = 8) {
    const nowMs = now.getTime();
    for (let dayOffset = 0; dayOffset < lookaheadDays; dayOffset += 1) {
        const candidateDate = new Date(nowMs + dayOffset * 86_400_000);
        let best = null;
        for (const reminder of reminders) {
            for (const occurrence of getReminderOccurrences(reminder, candidateDate, timezone)) {
                if (occurrence.at < nowMs) continue;
                if (!best || occurrence.at < best.occurrence.at) best = { reminder, occurrence };
            }
        }
        if (best) {
            return {
                reminderId: Number(best.reminder.id),
                medicationName: best.reminder.medicationName,
                time: best.occurrence.key.split("T")[1],
                at: best.occurrence.at
            };
        }
    }
    return null;
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

/**
 * Modo debug opt-in: defina no DevTools `localStorage.setItem("medibotReminderDebug", "1")`
 * e recarregue a página (ou crie/edite um lembrete para o agendador reiniciar). A cada
 * checagem (a cada 15s) o console mostra, via console.debug, a hora atual no fuso do
 * usuário, quantos lembretes o agendador tem, e a decisão (disparar/ignorar + motivo)
 * para cada ocorrência — só com ids de lembrete, nunca nome de medicamento. Para
 * desligar: `localStorage.removeItem("medibotReminderDebug")`.
 */
function isReminderDebugEnabled(storage) {
    try {
        return storage?.getItem("medibotReminderDebug") === "1";
    } catch {
        return false;
    }
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
        onDeliveryError,
        now = () => new Date(),
        visibilityState = () => (typeof document !== "undefined" ? document.visibilityState : "visible"),
        // Nunca `setIntervalFn = setInterval` (e o mesmo para clearInterval): guardar a
        // função nativa como propriedade e chamá-la como `this.setIntervalFn(...)` invoca
        // setInterval com `this` = a instância do agendador, não a Window, e o Chromium
        // responde com "TypeError: Illegal invocation". O wrapper abaixo chama
        // setInterval/clearInterval como função solta (sem receiver), que é sempre seguro.
        setIntervalFn = (callback, delay) => setInterval(callback, delay),
        clearIntervalFn = (id) => clearInterval(id)
    }) {
        this.userId = String(userId);
        this.timezone = timezone;
        this.notification = notification;
        this.storage = storage;
        this.onNavigate = onNavigate;
        this.onDeliveryError = onDeliveryError;
        this.now = now;
        this.visibilityState = visibilityState;
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
        // Antes, ficar com a aba escondida parava o setInterval (abaixo) até o usuário
        // voltar o foco — por isso um lembrete podia atrasar minutos: só disparava no
        // "recheck" ao focar a aba. O polling de 15s deve continuar em segundo plano
        // (os navegadores já reduzem a frequência de timers escondidos por conta própria,
        // não precisamos fazer isso manualmente); ao voltar, só adiantamos a checagem.
        if (!isVisible) return;
        if (this.lastCheck === null) this.lastCheck = this.now().getTime() - MAX_CATCH_UP_MS;
        this.check();
        if (this.timer === null) this.timer = this.setIntervalFn(() => this.check(), 15_000);
    }

    check() {
        const current = this.now().getTime();
        const previous = this.lastCheck ?? current - 60_000;
        this.lastCheck = current;
        const debug = isReminderDebugEnabled(this.storage);
        const decisions = debug ? [] : null;

        for (const reminder of this.reminders) {
            const occurrences = getReminderOccurrences(reminder, new Date(current), this.timezone);
            if (debug && occurrences.length === 0) {
                decisions.push({ reminderId: Number(reminder.id), decision: "skip", motivo: "sem ocorrência agora (vigência, dia da semana ou horário inválido)" });
            }

            for (const occurrence of occurrences) {
                const tooEarly = occurrence.at > current;
                const tooLate = current - occurrence.at > MAX_CATCH_UP_MS;
                const alreadyDelivered = this.delivered.has(occurrence.key);
                const missedWindow = occurrence.at <= previous && !this.pending.has(occurrence.key);
                const shouldSkip = tooEarly || tooLate || missedWindow || alreadyDelivered;

                if (debug) {
                    const motivo = alreadyDelivered ? "já entregue (dedupe)"
                        : tooEarly ? "ainda não chegou a hora"
                        : tooLate ? "venceu há mais de 5 min (fora da tolerância)"
                        : missedWindow ? "passou da janela da checagem anterior sem ficar pendente"
                        : "disparar";
                    decisions.push({ reminderId: Number(reminder.id), occurrenceAt: new Date(occurrence.at).toISOString(), decision: shouldSkip ? "skip" : "fire", motivo });
                }

                if (shouldSkip) continue;

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
                } catch (error) {
                    this.pending.add(occurrence.key);
                    /* Uma falha ao criar a notificação não é registrada como entrega. */
                    if (debug) console.debug("[MediBot] falha ao exibir notificação", { reminderId: Number(reminder.id), error: String(error) });
                    // `new Notification()` pode lançar mesmo com permissão concedida (ex.:
                    // Chrome Android exige Service Worker); avisa quem criou o agendador
                    // para ele não continuar anunciando notificações como "ativas".
                    this.onDeliveryError?.(error);
                }
            }
        }

        if (debug) {
            const parts = getTimezoneParts(new Date(current), this.timezone);
            const horaAtual = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
            console.debug("[MediBot] agendador de lembretes", {
                horaAtual: `${horaAtual} (${this.timezone})`,
                visibilityState: this.visibilityState(),
                totalLembretesAtivos: this.reminders.length,
                chavesJaEntregues: [...this.delivered],
                decisoes: decisions
            });
        }
    }
}

export function startReminderSchedulerIfAllowed({
    scheduler, userId, timezone = DEFAULT_REMINDER_TIME_ZONE, notification, isSecureContext, storage,
    reminders, onNavigate, onDeliveryError, now, visibilityState, setIntervalFn, clearIntervalFn
}) {
    if (getNotificationAvailability({ notification, isSecureContext }) !== "enabled" || !Number.isSafeInteger(userId) || userId <= 0) {
        scheduler?.stop();
        return null;
    }
    const matchesCurrent = scheduler?.userId === String(userId) && scheduler?.timezone === timezone;
    if (scheduler && !matchesCurrent) scheduler.stop();
    const activeScheduler = matchesCurrent
        ? scheduler
        : new ReminderNotificationScheduler({ userId, timezone, notification, storage, onNavigate, onDeliveryError, now, visibilityState, setIntervalFn, clearIntervalFn });
    activeScheduler.setReminders(reminders);
    activeScheduler.start();
    return activeScheduler;
}
