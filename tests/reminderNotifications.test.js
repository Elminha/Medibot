import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_REMINDER_TIME_ZONE,
    fetchAuthenticatedReminders,
    getNextOccurrence,
    getNotificationAvailability,
    getReminderOccurrences,
    getTimezoneParts,
    ReminderNotificationScheduler,
    startReminderSchedulerIfAllowed
} from "../public/reminderNotifications.js";

const active = (id, times, overrides = {}) => ({
    id, times, weekdays: [], startsOn: null, endsOn: null, active: true, ...overrides
});

test("interpreta horário e dia no fuso informado, não no fuso do dispositivo", () => {
    const instant = new Date("2024-01-08T13:30:00.000Z");
    assert.deepEqual(
        getTimezoneParts(instant, DEFAULT_REMINDER_TIME_ZONE),
        { year: 2024, month: 1, day: 8, hour: 10, minute: 30, second: 0, weekday: 1, dateKey: "2024-01-08" }
    );
    const occurrences = getReminderOccurrences(active(3, ["10:30"]), instant, DEFAULT_REMINDER_TIME_ZONE);
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0].at, instant.getTime());
});

test("vários horários no mesmo lembrete geram uma ocorrência por horário", () => {
    const instant = new Date("2024-01-08T00:00:00.000Z");
    const occurrences = getReminderOccurrences(active(9, ["08:00", "14:00", "20:00"]), instant, DEFAULT_REMINDER_TIME_ZONE);
    assert.equal(occurrences.length, 3);
    assert.deepEqual(occurrences.map((o) => o.key.split("T")[1]), ["08:00", "14:00", "20:00"]);
});

test("dias vazios disparam todos os dias; dias específicos respeitam o dia da semana local", () => {
    const monday = new Date("2024-01-08T13:30:00.000Z");
    const sunday = new Date("2024-01-14T13:30:00.000Z");
    assert.equal(getReminderOccurrences(active(1, ["10:30"]), monday).length, 1);
    assert.equal(getReminderOccurrences(active(1, ["10:30"], { weekdays: [1, 2, 3, 4, 5] }), monday).length, 1);
    assert.equal(getReminderOccurrences(active(1, ["10:30"], { weekdays: [1, 2, 3, 4, 5] }), sunday).length, 0);
    assert.equal(getReminderOccurrences(active(1, ["10:30"], { weekdays: [0, 6] }), sunday).length, 1);
});

test("respeita vigência (startsOn/endsOn) no fuso informado", () => {
    const beforeStart = new Date("2024-01-07T13:30:00.000Z");
    const onStart = new Date("2024-01-08T13:30:00.000Z");
    const afterEnd = new Date("2024-01-09T13:30:00.000Z");
    const reminder = active(5, ["10:30"], { startsOn: "2024-01-08", endsOn: "2024-01-08" });
    assert.equal(getReminderOccurrences(reminder, beforeStart).length, 0);
    assert.equal(getReminderOccurrences(reminder, onStart).length, 1);
    assert.equal(getReminderOccurrences(reminder, afterEnd).length, 0);
});

test("lembretes inativos ou sem horário válido não geram ocorrência", () => {
    const now = new Date("2024-01-08T13:30:00.000Z");
    assert.equal(getReminderOccurrences({ ...active(1, ["10:30"]), active: false }, now).length, 0);
    assert.equal(getReminderOccurrences(active(1, []), now).length, 0);
    assert.equal(getReminderOccurrences(active(1, ["25:99"]), now).length, 0);
});

test("aceita defensivamente o formato bruto do node-pg: Date (coluna DATE) e 'HH:MM:SS' (coluna TIME)", () => {
    // Antes da correção em reminderService.ts (SELECT_REMINDER_COLUMNS), starts_on/
    // ends_on saíam como objeto Date (node-pg converte DATE para Date em UTC meia-noite)
    // e, depois de um round-trip por JSON, como string ISO "YYYY-MM-DDTHH:MM:SS.sssZ" —
    // bem diferente do "YYYY-MM-DD" que o agendador comparava. Isso fazia
    // "2024-01-08" < "2024-01-08T00:00:00.000Z" (prefixo é "menor" que o todo) e o
    // lembrete parecia "ainda não começou" bem no dia em que foi criado.
    const pgShapedReminder = {
        id: 42,
        medicationName: "Dipirona",
        times: ["08:00:00", "20:00:00"], // "HH:MM:SS" bruto de uma coluna TIME sem to_char
        weekdays: [],
        startsOn: new Date("2024-01-08T00:00:00.000Z"), // Date, como node-pg devolve p/ DATE
        endsOn: null,
        active: true
    };
    const onStartDay = new Date("2024-01-08T11:00:00.000Z");
    const occurrences = getReminderOccurrences(pgShapedReminder, onStartDay, DEFAULT_REMINDER_TIME_ZONE);
    assert.equal(occurrences.length, 2);
    assert.deepEqual(occurrences.map((o) => o.key.split("T")[1]), ["08:00", "20:00"]);

    // Um dia ANTES do início (startsOn ainda como Date de verdade): comparar string com
    // Date sem normalizar cai em NaN (nem < nem >), então a checagem de vigência era
    // simplesmente ignorada e o lembrete vazava antes de começar. Normalizado, bloqueia.
    const beforeStart = new Date("2024-01-07T11:00:00.000Z");
    assert.equal(getReminderOccurrences(pgShapedReminder, beforeStart, DEFAULT_REMINDER_TIME_ZONE).length, 0);

    // Mesma coisa, mas já serializado em JSON (string ISO, não mais um Date de verdade).
    const jsonShapedReminder = { ...pgShapedReminder, startsOn: "2024-01-08T00:00:00.000Z" };
    assert.equal(getReminderOccurrences(jsonShapedReminder, onStartDay, DEFAULT_REMINDER_TIME_ZONE).length, 2);
});

test("o agendador reconhece um lembrete criado depois de já estar rodando (setReminders em runtime)", () => {
    let now = new Date("2024-01-08T13:29:50.000Z");
    const notifications = [];
    class MockNotification { constructor(_title, options) { notifications.push(options); } }
    const scheduler = new ReminderNotificationScheduler({
        userId: 1, notification: MockNotification, storage: null, onNavigate() {}, now: () => now, setIntervalFn: () => 1, clearIntervalFn() {}
    });
    scheduler.start(); // nenhum lembrete ainda: a primeira checagem não tem nada a fazer
    assert.equal(notifications.length, 0);

    // "cria" um lembrete para 10:30 (13:30 UTC) enquanto o agendador já está rodando —
    // é exatamente o que acontece quando loadReminders()/setReminders roda de novo
    // depois de criar, editar, pausar/reativar ou excluir um lembrete com a aba aberta.
    scheduler.setReminders([active(77, ["10:30"])]);

    now = new Date("2024-01-08T13:30:03.000Z"); // próxima checagem periódica, 15s depois
    scheduler.check();
    assert.equal(notifications.length, 1);
    scheduler.stop();
});

test("modo debug (localStorage medibotReminderDebug=1) loga a decisão por lembrete via console.debug, sem nome de medicamento", () => {
    const now = new Date("2024-01-08T13:30:00.000Z");
    const values = new Map();
    const debugStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const calls = [];
    const originalDebug = console.debug;
    console.debug = (...args) => calls.push(args);
    try {
        const scheduler = new ReminderNotificationScheduler({
            userId: 1, notification: class { constructor() {} }, storage: debugStorage, onNavigate() {}, now: () => now, setIntervalFn: () => 1, clearIntervalFn() {}
        });
        scheduler.setReminders([active(55, ["10:30"], { medicationName: "Dipirona" })]);

        scheduler.check();
        assert.equal(calls.length, 0, "desligado por padrão");

        debugStorage.setItem("medibotReminderDebug", "1");
        scheduler.check();
        assert.equal(calls.length, 1);
        const [label, payload] = calls[0];
        assert.match(label, /agendador de lembretes/);
        assert.equal(payload.totalLembretesAtivos, 1);
        assert.ok(Array.isArray(payload.decisoes) && payload.decisoes.length > 0);
        assert.ok(!JSON.stringify(payload).includes("Dipirona"), "nunca deve logar o nome do medicamento");
        scheduler.stop();
    } finally {
        console.debug = originalDebug;
    }
});

test("getNextOccurrence encontra a próxima ocorrência mesmo que seja só no dia seguinte", () => {
    const now = new Date("2024-01-08T23:50:00.000Z"); // 20:50 em São Paulo (UTC-3)
    const reminder = active(3, ["02:59"], { medicationName: "Nimesulida" });
    const next = getNextOccurrence([reminder], now, DEFAULT_REMINDER_TIME_ZONE);
    assert.ok(next);
    assert.equal(next.time, "02:59");
    assert.equal(next.medicationName, "Nimesulida");
    assert.ok(next.at > now.getTime());
});

test("getNextOccurrence devolve null sem lembrete ativo futuro", () => {
    assert.equal(getNextOccurrence([], new Date(), DEFAULT_REMINDER_TIME_ZONE), null);
    assert.equal(
        getNextOccurrence([{ ...active(1, ["08:00"]), active: false }], new Date(), DEFAULT_REMINDER_TIME_ZONE),
        null
    );
});

test("start()/stop() usam o setInterval/clearInterval nativos sem receiver errado (reproduz o 'Illegal invocation' real do Chromium quando setIntervalFn não é injetado)", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let scheduledCount = 0;

    // Simula o comportamento real do navegador: setInterval/clearInterval nativos
    // lançam "Illegal invocation" quando chamados com `this` diferente de
    // globalThis/undefined (é exatamente o que acontece se o código guardar a função
    // nativa como propriedade de um objeto e chamá-la como `this.setIntervalFn(...)`).
    function strictSetInterval(callback, delay) {
        if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
        scheduledCount += 1;
        return originalSetInterval(callback, delay);
    }
    function strictClearInterval(id) {
        if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
        originalClearInterval(id);
    }

    globalThis.setInterval = strictSetInterval;
    globalThis.clearInterval = strictClearInterval;
    try {
        const scheduler = new ReminderNotificationScheduler({
            userId: 1, notification: class { constructor() {} }, storage: null, onNavigate() {}
        });
        assert.doesNotThrow(() => scheduler.start());
        assert.equal(scheduledCount, 1);
        assert.doesNotThrow(() => scheduler.stop());
    } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});

test("cruza o horário entre verificações e não repete na mesma ocorrência", () => {
    let now = new Date("2024-01-08T13:29:50.000Z");
    const instances = [];
    class MockNotification { constructor(title, options) { instances.push({ title, options }); } close() {} }
    const storage = new Map();
    const store = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) };
    const scheduler = new ReminderNotificationScheduler({ userId: 12, notification: MockNotification, storage: store, onNavigate() {}, now: () => now, setIntervalFn: () => 1, clearIntervalFn() {} });
    scheduler.setReminders([active(9, ["10:30"])]);
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
        reminders: [active(14, ["10:30"])],
        storage: null,
        onNavigate() {},
        now: () => now,
        setIntervalFn: () => { intervalCount += 1; return intervalCount; },
        clearIntervalFn() {}
    };
    let scheduler = startReminderSchedulerIfAllowed(options);
    assert.ok(scheduler);
    scheduler = startReminderSchedulerIfAllowed({ ...options, scheduler, reminders: [active(14, ["10:30"])] });
    assert.equal(intervalCount, 1);
    assert.equal(permissionRequests, 0);
    assert.equal(notifications.length, 1);
    scheduler.stop();
});

test("troca de fuso do usuário recria o agendador em vez de reaproveitar o anterior", () => {
    let intervalCount = 0;
    const options = {
        userId: 22,
        timezone: "America/Sao_Paulo",
        notification: class { constructor() {} },
        isSecureContext: true,
        reminders: [],
        storage: null,
        onNavigate() {},
        now: () => new Date("2024-01-08T13:30:20.000Z"),
        setIntervalFn: () => { intervalCount += 1; return intervalCount; },
        clearIntervalFn() {}
    };
    options.notification.permission = "granted";
    options.notification.requestPermission = () => {};
    const first = startReminderSchedulerIfAllowed(options);
    const second = startReminderSchedulerIfAllowed({ ...options, scheduler: first, timezone: "America/Manaus" });
    assert.notEqual(first, second);
    assert.equal(second.timezone, "America/Manaus");
    second.stop();
});

test("retomada após voltar de aba em segundo plano notifica no máximo uma vez dentro da tolerância", () => {
    let now = new Date("2024-01-08T13:29:50.000Z");
    const notifications = [];
    let activeIntervals = 0;
    let intervalId = 0;
    class MockNotification { constructor(_title, options) { notifications.push(options); } }
    const scheduler = new ReminderNotificationScheduler({ userId: 4, notification: MockNotification, storage: null, onNavigate() {}, now: () => now, setIntervalFn: () => { activeIntervals += 1; return ++intervalId; }, clearIntervalFn: () => { activeIntervals -= 1; } });
    scheduler.setReminders([active(7, ["10:30"])]);
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
    scheduler.setReminders([active(7, ["10:30"])]);
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
    const first = create(12); first.setReminders([active(9, ["10:30"])]); first.start(); first.stop();
    const reloaded = create(12); reloaded.setReminders([active(9, ["10:30"])]); reloaded.start(); reloaded.stop();
    const otherUser = create(13); otherUser.setReminders([active(9, ["10:30"])]); otherUser.start(); otherUser.stop();
    assert.equal(instances.length, 2);
    assert.equal(values.size, 2);
});

test("falha ao criar notificação não marca ocorrência como entregue e permite tentar novamente", () => {
    let now = new Date("2024-01-08T13:30:00.000Z");
    let attempts = 0;
    class FlakyNotification { constructor() { attempts += 1; if (attempts === 1) throw new Error("blocked"); } }
    const scheduler = new ReminderNotificationScheduler({ userId: 1, notification: FlakyNotification, storage: null, onNavigate() {}, now: () => now, setIntervalFn: () => 1, clearIntervalFn() {} });
    scheduler.setReminders([active(9, ["10:30"])]); scheduler.start();
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
        return { ok: true, async json() { return { reminders: [], timezone: "America/Sao_Paulo" }; } };
    }, "jwt-user-a");
    assert.deepEqual(result, []);
    assert.equal(requests[0].url, "/api/reminders");
    assert.equal(requests[0].options.headers.Authorization, "Bearer jwt-user-a");
    assert.equal(requests[0].url.includes("userId"), false);
    await assert.rejects(fetchAuthenticatedReminders(async () => ({ ok: false }), "jwt-user-a"), /reminders-load-failed/);
    await assert.rejects(fetchAuthenticatedReminders(async () => { throw new Error("network"); }, "jwt-user-a"), /network/);
    await assert.rejects(fetchAuthenticatedReminders(async () => { throw new Error("must not call"); }, ""), /authentication-required/);
});
