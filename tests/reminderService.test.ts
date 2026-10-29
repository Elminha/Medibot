import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { getDatabasePool } = await import("../src/database/database.ts");
const { MedicationNotFoundError } = await import("../src/services/medicationService.ts");
const {
    createReminder,
    deleteReminder,
    getReminderById,
    listReminders,
    ReminderNotFoundError,
    todayInTimezone,
    updateReminder
} = await import("../src/services/reminderService.ts");

const pool = getDatabasePool();

interface FakeMedication { id: number; user_id: number; name: string; }
interface FakeReminder {
    id: number; medication_id: number; time: string | null; frequency: string;
    active: boolean; starts_on: string; ends_on: string | null;
}

function setupDb() {
    const medications: FakeMedication[] = [
        { id: 1, user_id: 10, name: "Dipirona" },
        { id: 2, user_id: 20, name: "Losartana" }
    ];
    const reminders: FakeReminder[] = [];
    const reminderTimes: Array<{ reminder_id: number; time: string }> = [];
    const reminderWeekdays: Array<{ reminder_id: number; weekday: number }> = [];
    let nextReminderId = 1;

    function buildReminderRow(r: FakeReminder) {
        const medication = medications.find((m) => m.id === r.medication_id)!;
        const times = reminderTimes.filter((t) => t.reminder_id === r.id).map((t) => t.time).sort();
        const weekdays = reminderWeekdays
            .filter((w) => w.reminder_id === r.id)
            .map((w) => w.weekday)
            .sort((a, b) => a - b);
        return {
            id: String(r.id),
            medication_id: String(r.medication_id),
            medication_name: medication.name,
            active: r.active,
            starts_on: r.starts_on,
            ends_on: r.ends_on,
            times,
            weekdays
        };
    }

    async function handle(text: string, params: unknown[] = []) {
        const sql = text.trim();

        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
            return { rows: [], rowCount: 0 };
        }

        if (sql.includes("FROM medications") && sql.includes("WHERE id = $1 AND user_id = $2")) {
            const [id, userId] = params as [number, number];
            const medication = medications.find((m) => m.id === id && m.user_id === userId);
            return medication
                ? {
                    rows: [{
                        id: String(medication.id), user_id: String(medication.user_id), name: medication.name,
                        dosage: null, instructions: null, active: true, created_at: new Date(), updated_at: new Date()
                    }],
                    rowCount: 1
                }
                : { rows: [], rowCount: 0 };
        }

        if (sql.startsWith("INSERT INTO reminders")) {
            const [medicationId, time, frequency, active, startsOn, endsOn] =
                params as [number, string, string, boolean, string, string | null];
            const id = nextReminderId++;
            reminders.push({ id, medication_id: medicationId, time, frequency, active, starts_on: startsOn, ends_on: endsOn });
            return { rows: [{ id: String(id) }], rowCount: 1 };
        }

        if (sql.startsWith("INSERT INTO reminder_times")) {
            const [reminderId, time] = params as [number, string];
            reminderTimes.push({ reminder_id: reminderId, time });
            return { rows: [], rowCount: 1 };
        }

        if (sql.startsWith("INSERT INTO reminder_weekdays")) {
            const [reminderId, weekday] = params as [number, number];
            reminderWeekdays.push({ reminder_id: reminderId, weekday });
            return { rows: [], rowCount: 1 };
        }

        if (sql.includes("FROM reminders r") && sql.includes("WHERE r.id = $1 AND m.user_id = $2")) {
            const [id, userId] = params as [number, number];
            const reminder = reminders.find((r) => r.id === id);
            const medication = reminder ? medications.find((m) => m.id === reminder.medication_id) : undefined;
            if (!reminder || !medication || medication.user_id !== userId) {
                return { rows: [], rowCount: 0 };
            }
            return { rows: [buildReminderRow(reminder)], rowCount: 1 };
        }

        if (sql.includes("FROM reminders r") && sql.includes("WHERE m.user_id = $1")) {
            const [userId] = params as [number];
            const rows = reminders
                .filter((r) => medications.find((m) => m.id === r.medication_id)?.user_id === userId)
                .sort((a, b) => a.id - b.id)
                .map(buildReminderRow);
            return { rows, rowCount: rows.length };
        }

        if (sql.startsWith("UPDATE reminders")) {
            const [medicationId, time, frequency, active, startsOn, endsOn, id] =
                params as [number, string, string, boolean, string, string | null, number];
            const reminder = reminders.find((r) => r.id === id);
            if (!reminder) {
                return { rows: [], rowCount: 0 };
            }
            Object.assign(reminder, { medication_id: medicationId, time, frequency, active, starts_on: startsOn, ends_on: endsOn });
            return { rows: [{ id: String(id) }], rowCount: 1 };
        }

        if (sql.startsWith("DELETE FROM reminder_times")) {
            const [reminderId] = params as [number];
            for (let i = reminderTimes.length - 1; i >= 0; i -= 1) {
                if (reminderTimes[i].reminder_id === reminderId) reminderTimes.splice(i, 1);
            }
            return { rows: [], rowCount: 0 };
        }

        if (sql.startsWith("DELETE FROM reminder_weekdays")) {
            const [reminderId] = params as [number];
            for (let i = reminderWeekdays.length - 1; i >= 0; i -= 1) {
                if (reminderWeekdays[i].reminder_id === reminderId) reminderWeekdays.splice(i, 1);
            }
            return { rows: [], rowCount: 0 };
        }

        if (sql.startsWith("DELETE FROM reminders")) {
            const [id, userId] = params as [number, number];
            const index = reminders.findIndex((r) =>
                r.id === id && medications.find((m) => m.id === r.medication_id)?.user_id === userId);
            if (index === -1) {
                return { rows: [], rowCount: 0 };
            }
            reminders.splice(index, 1);
            return { rows: [], rowCount: 1 };
        }

        throw new Error(`fakeQuery não sabe lidar com: ${sql}`);
    }

    mock.method(pool, "query", async (sqlText: string, params?: unknown[]) => handle(sqlText, params));
    mock.method(pool, "connect", async () => ({
        query: async (sqlText: string, params?: unknown[]) => handle(sqlText, params),
        release: () => {}
    }));

    return { medications, reminders, reminderTimes, reminderWeekdays };
}

test.afterEach(() => {
    mock.restoreAll();
});

test("todayInTimezone calcula no fuso informado, não no fuso do servidor (UTC)", () => {
    const now = new Date("2024-01-08T02:30:00.000Z");
    assert.equal(todayInTimezone("America/Sao_Paulo", now), "2024-01-07");
    assert.equal(todayInTimezone("UTC", now), "2024-01-08");
});

test("createReminder grava horários/dias e espelha o primeiro horário e uma frequência legada", async () => {
    const db = setupDb();
    const reminder = await createReminder(
        10,
        { medicationId: 1, times: ["20:00", "08:00"], weekdays: [1, 2, 3, 4, 5] },
        "America/Sao_Paulo"
    );

    assert.deepEqual(reminder.times, ["08:00", "20:00"]);
    assert.deepEqual(reminder.weekdays, [1, 2, 3, 4, 5]);
    assert.equal(reminder.status, "active");
    assert.deepEqual(reminder.channels, ["browser"]);

    const row = db.reminders[0];
    assert.equal(row.time, "08:00");
    assert.equal(row.frequency, "weekdays");
});

test("createReminder com dias que não são seg-sex grava frequência legada 'daily'", async () => {
    const db = setupDb();
    await createReminder(10, { medicationId: 1, times: ["08:00"], weekdays: [0, 6] }, "America/Sao_Paulo");
    assert.equal(db.reminders[0].frequency, "daily");
});

test("createReminder recusa medicamento de outro usuário", async () => {
    setupDb();
    await assert.rejects(
        createReminder(10, { medicationId: 2, times: ["08:00"], weekdays: [] }, "America/Sao_Paulo"),
        MedicationNotFoundError
    );
});

test("startsOn ausente usa a data de hoje no fuso do usuário", async () => {
    setupDb();
    const reminder = await createReminder(10, { medicationId: 1, times: ["08:00"], weekdays: [] }, "America/Sao_Paulo");
    assert.equal(reminder.startsOn, todayInTimezone("America/Sao_Paulo"));
});

test("status: paused quando inativo, ended quando ends_on já passou, active no caso comum", async () => {
    setupDb();
    const paused = await createReminder(
        10, { medicationId: 1, times: ["08:00"], weekdays: [], active: false }, "America/Sao_Paulo"
    );
    assert.equal(paused.status, "paused");

    const ended = await createReminder(
        10, { medicationId: 1, times: ["08:00"], weekdays: [], startsOn: "2020-01-01", endsOn: "2020-01-02" }, "America/Sao_Paulo"
    );
    assert.equal(ended.status, "ended");

    const active = await createReminder(10, { medicationId: 1, times: ["08:00"], weekdays: [] }, "America/Sao_Paulo");
    assert.equal(active.status, "active");
});

test("listReminders só devolve lembretes do usuário autenticado, ordenados por id", async () => {
    setupDb();
    await createReminder(10, { medicationId: 1, times: ["08:00"], weekdays: [] }, "America/Sao_Paulo");
    await createReminder(10, { medicationId: 1, times: ["12:00"], weekdays: [] }, "America/Sao_Paulo");

    const ownReminders = await listReminders(10, "America/Sao_Paulo");
    assert.equal(ownReminders.length, 2);
    assert.deepEqual(ownReminders.map((r) => r.id), [1, 2]);

    const otherUserReminders = await listReminders(20, "America/Sao_Paulo");
    assert.equal(otherUserReminders.length, 0);
});

test("getReminderById de outro usuário lança ReminderNotFoundError", async () => {
    setupDb();
    const reminder = await createReminder(10, { medicationId: 1, times: ["08:00"], weekdays: [] }, "America/Sao_Paulo");
    await assert.rejects(getReminderById(20, reminder.id, "America/Sao_Paulo"), ReminderNotFoundError);
});

test("updateReminder substitui horários e dias em uma transação (sem manter os antigos)", async () => {
    setupDb();
    const created = await createReminder(
        10, { medicationId: 1, times: ["08:00", "20:00"], weekdays: [1, 2, 3, 4, 5] }, "America/Sao_Paulo"
    );

    const updated = await updateReminder(10, created.id, { times: ["09:00"], weekdays: [] }, "America/Sao_Paulo");

    assert.deepEqual(updated.times, ["09:00"]);
    assert.deepEqual(updated.weekdays, []);
});

test("updateReminder sem medicationId mantém o medicamento atual e não exige posse de novo", async () => {
    setupDb();
    const created = await createReminder(10, { medicationId: 1, times: ["08:00"], weekdays: [] }, "America/Sao_Paulo");
    const updated = await updateReminder(10, created.id, { active: false }, "America/Sao_Paulo");
    assert.equal(updated.medicationId, 1);
    assert.equal(updated.active, false);
    assert.equal(updated.status, "paused");
});

test("updateReminder trocando medicamento valida posse do novo medicamento", async () => {
    setupDb();
    const created = await createReminder(10, { medicationId: 1, times: ["08:00"], weekdays: [] }, "America/Sao_Paulo");
    await assert.rejects(
        updateReminder(10, created.id, { medicationId: 2 }, "America/Sao_Paulo"),
        MedicationNotFoundError
    );
});

test("deleteReminder remove lembrete do dono e recusa de outro usuário", async () => {
    setupDb();
    const created = await createReminder(10, { medicationId: 1, times: ["08:00"], weekdays: [] }, "America/Sao_Paulo");
    await assert.rejects(deleteReminder(20, created.id), ReminderNotFoundError);
    await deleteReminder(10, created.id);
    await assert.rejects(getReminderById(10, created.id, "America/Sao_Paulo"), ReminderNotFoundError);
});
