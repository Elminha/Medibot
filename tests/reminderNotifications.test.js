import test from "node:test";
import assert from "node:assert/strict";
import {
    fetchAuthenticatedReminders,
    getNotificationAvailability,
    getReminderOccurrence,
    getSaoPauloParts,
    ReminderNotificationScheduler,
    startReminderSchedulerIfAllowed
} from "../public/reminderNotifications.js";

const active = (id, time, frequency = "daily") => ({ id, time, frequency, active: true });

test("interpreta horário e dia no fuso America/Sao_Paulo, não no fuso do dispositivo", () => {
    const instant = new Date("2024-01-08T13:30:00.000Z");
    assert.deepEqual(getSaoPauloParts(instant), { year: 2024, month: 1, day: 8, hour: 10, minute: 30, second: 0, weekday: 1 });
    assert.equal(getReminderOccurrence(active(3, "10:30"), instant).at, instant.getTime());
});

test("daily e weekdays respeitam dias e mudança de data local", () => {
    const monday = new Date("2024-01-08T13:30:00.000Z");
    const tuesday = new Date("2024-01-09T13:30:00.000Z");
    const sunday = new Date("2024-01-14T13:30:00.000Z");
    assert.ok(getReminderOccurrence(active(1, "10:30", "daily"), tuesday));
    assert.ok(getReminderOccurrence(active(1, "10:30", "weekdays"), monday));
    assert.equal(getReminderOccurrence(active(1, "10:30", "weekdays"), sunday), null);
    assert.notEqual(getReminderOccurrence(active(1, "10:30"), monday).key, getReminderOccurrence(active(1, "10:30"), tuesday).key);
});

test("weekly e custom não disparam sem dias definidos", () => {
    const now = new Date("2024-01-08T13:30:00.000Z");
    assert.equal(getReminderOccurrence(active(1, "10:30", "weekly"), now), null);
    assert.equal(getReminderOccurrence(active(1, "10:30", "custom"), now), null);
});

test("lembretes inativos são ignorados", () => {
    assert.equal(getReminderOccurrence({ ...active(1, "10:30"), active: false }, new Date("2024-01-08T13:30:00Z")), null);
});

test("cruza o horário entre verificações e não repete na mesma ocorrência", () => {
    let now = new Date("2024-01-08T13:29:50.000Z");
    const instances = [];
    class MockNotification { constructor(title, options) { instances.push({ title, options }); } close() {} }
    const storage = new Map();
    const store = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) };
    const scheduler = new ReminderNotificationScheduler({ userId: 12, notification: MockNotification, storage: store, onNavigate() {}, now: () => now, setIntervalFn: () => 1, clearIntervalFn() {} });
    scheduler.setReminders([active(9, "10:30")]);
    scheduler.start();
    assert.equal(instances.length, 0);
    now = new Date("2024-01-08T13:30:03.000Z");
    scheduler.check();
    scheduler.check();
    assert.equal(instances.length, 1);
    assert.match(instances[0].options.body, /conferir seu lembrete/);
    scheduler.stop();
});

test("permissão concedida retoma automaticamente o agendador sem novo pedido", () => {
    let now = new Date("2024-01-08T13:30:20.000Z");
    let intervalCount = 0;
    let permissionRequests = 0;
    const notifications = [];
    class MockNotification { constructor(_title, options) { notifications.push(options); } }
    MockNotification.permission = "granted";
    MockNotification.requestPermission = () => { permissionRequests += 1; };
    const options = {
        userId: 22,
        notification: MockNotification,
        isSecureContext: true,
        reminders: [active(14, "10:30")],
        storage: null,
        onNavigate() {},
        now: () => now,
        setIntervalFn: () => { intervalCount += 1; return intervalCount; },
        clearIntervalFn() {}
    };
    let scheduler = startReminderSchedulerIfAllowed(options);
    assert.ok(scheduler);
    scheduler = startReminderSchedulerIfAllowed({ ...options, scheduler, reminders: [active(14, "10:30")] });
    assert.equal(intervalCount, 1);
    assert.equal(permissionRequests, 0);
    assert.equal(notifications.length, 1);
    scheduler.stop();
});

test("retomada após voltar de aba em segundo plano notifica no máximo uma vez dentro da tolerância", () => {
    let now = new Date("2024-01-08T13:29:50.000Z");
    const notifications = [];
    let activeIntervals = 0;
    let intervalId = 0;
    class MockNotification { constructor(_title, options) { notifications.push(options); } }
    const scheduler = new ReminderNotificationScheduler({ userId: 4, notification: MockNotification, storage: null, onNavigate() {}, now: () => now, setIntervalFn: () => { activeIntervals += 1; return ++intervalId; }, clearIntervalFn: () => { activeIntervals -= 1; } });
    scheduler.setReminders([active(7, "10:30")]);
    scheduler.start();
    scheduler.handleVisibilityChange(false);
    assert.equal(activeIntervals, 0);
    now = new Date("2024-01-08T13:33:00.000Z");
    scheduler.handleVisibilityChange(true);
    scheduler.handleVisibilityChange(true);
    assert.equal(notifications.length, 1);
    assert.equal(activeIntervals, 1);
    scheduler.stop();
});

test("retomada ignora ocorrências vencidas há mais de cinco minutos", () => {
    let now = new Date("2024-01-08T13:29:50.000Z");
    const notifications = [];
    class MockNotification { constructor(_title, options) { notifications.push(options); } }
    const scheduler = new ReminderNotificationScheduler({ userId: 4, notification: MockNotification, storage: null, onNavigate() {}, now: () => now, setIntervalFn: () => 1, clearIntervalFn() {} });
    scheduler.setReminders([active(7, "10:30")]);
    scheduler.start();
    now = new Date("2024-01-08T13:36:00.000Z");
    scheduler.handleVisibilityChange(true);
    assert.equal(notifications.length, 0);
    scheduler.stop();
});

test("persistência evita duplicidade após recarga, sem misturar usuários", () => {
    let now = new Date("2024-01-08T13:30:00.000Z");
    const instances = [];
    class MockNotification { constructor(_title, options) { instances.push(options); } }
    const values = new Map();
    const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
    const create = (userId) => new ReminderNotificationScheduler({ userId, notification: MockNotification, storage, onNavigate() {}, now: () => now, setIntervalFn: () => 1, clearIntervalFn() {} });
    const first = create(12); first.setReminders([active(9, "10:30")]); first.start(); first.stop();
    const reloaded = create(12); reloaded.setReminders([active(9, "10:30")]); reloaded.start(); reloaded.stop();
    const otherUser = create(13); otherUser.setReminders([active(9, "10:30")]); otherUser.start(); otherUser.stop();
    assert.equal(instances.length, 2);
    assert.equal(values.size, 2);
});

test("falha ao criar notificação não marca ocorrência como entregue e permite tentar novamente", () => {
    let now = new Date("2024-01-08T13:30:00.000Z");
    let attempts = 0;
    class FlakyNotification { constructor() { attempts += 1; if (attempts === 1) throw new Error("blocked"); } }
    const scheduler = new ReminderNotificationScheduler({ userId: 1, notification: FlakyNotification, storage: null, onNavigate() {}, now: () => now, setIntervalFn: () => 1, clearIntervalFn() {} });
    scheduler.setReminders([active(9, "10:30")]); scheduler.start();
    scheduler.check();
    assert.equal(attempts, 2);
    scheduler.stop();
});

test("permissão negada é bloqueada e indisponibilidade não pede permissão", () => {
    let requests = 0;
    const denied = { permission: "denied", requestPermission() { requests += 1; } };
    const unavailable = { permission: "default" };
    assert.equal(getNotificationAvailability({ notification: denied, isSecureContext: true }), "blocked");
    assert.equal(getNotificationAvailability({ notification: unavailable, isSecureContext: true }), "blocked");
    assert.equal(getNotificationAvailability({ notification: { permission: "default", requestPermission() {} }, isSecureContext: false }), "blocked");
    assert.equal(requests, 0);
});

test("carregamento requer token e consulta apenas o endpoint do usuário autenticado", async () => {
    const requests = [];
    const result = await fetchAuthenticatedReminders(async (url, options) => {
        requests.push({ url, options });
        return { ok: true, async json() { return { reminders: [] }; } };
    }, "jwt-user-a");
    assert.deepEqual(result, []);
    assert.equal(requests[0].url, "/api/reminders");
    assert.equal(requests[0].options.headers.Authorization, "Bearer jwt-user-a");
    assert.equal(requests[0].url.includes("userId"), false);
    await assert.rejects(fetchAuthenticatedReminders(async () => ({ ok: false }), "jwt-user-a"), /reminders-load-failed/);
    await assert.rejects(fetchAuthenticatedReminders(async () => { throw new Error("network"); }, "jwt-user-a"), /network/);
    await assert.rejects(fetchAuthenticatedReminders(async () => { throw new Error("must not call"); }, ""), /authentication-required/);
});
