import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/medibot_test";

const { getDatabasePool } = await import("../src/database/database.ts");
const reminderRoutes = (await import("../src/routes/reminderRoutes.ts")).default;

const pool = getDatabasePool();

interface FakeUser { id: number; timezone: string; }
interface FakeMedication { id: number; user_id: number; name: string; }
interface FakeReminder {
    id: number; medication_id: number; time: string | null; frequency: string;
    active: boolean; starts_on: string; ends_on: string | null;
}

function tokenFor(userId: number): string {
    return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET as string, { expiresIn: "7d" });
}

function setupDb() {
    const users: FakeUser[] = [
        { id: 10, timezone: "America/Sao_Paulo" },
        { id: 20, timezone: "America/Sao_Paulo" }
    ];
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
            id: String(r.id), medication_id: String(r.medication_id), medication_name: medication.name,
            active: r.active, starts_on: r.starts_on, ends_on: r.ends_on, times, weekdays
        };
    }

    async function handle(text: string, params: unknown[] = []) {
        const sql = text.trim();

        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
            return { rows: [], rowCount: 0 };
        }

        if (sql.includes("FROM users")) {
            const [id] = params as [number];
            const user = users.find((u) => u.id === id);
            return user
                ? {
                    rows: [{
                        id: String(user.id), name: "Usuário Teste", email: "teste@exemplo.com", phone: null,
                        timezone: user.timezone, password_hash: "hash", telegram_chat_id: null, password_changed_at: null
                    }],
                    rowCount: 1
                }
                : { rows: [], rowCount: 0 };
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
            if (endsOn !== null && endsOn < startsOn) {
                throw Object.assign(new Error("check violation"), { code: "23514" });
            }
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
            if (endsOn !== null && endsOn < startsOn) {
                throw Object.assign(new Error("check violation"), { code: "23514" });
            }
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

    return { users, medications, reminders };
}

const app = express();
app.disable("etag");
app.use(express.json());
app.use("/api/reminders", reminderRoutes);

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
    server.close();
});

test.afterEach(() => {
    mock.restoreAll();
});

test("sem token: 401", async () => {
    setupDb();
    const response = await fetch(`${baseUrl}/api/reminders`);
    assert.equal(response.status, 401);
});

test("POST cria lembrete com múltiplos horários e dias, devolve times/weekdays", async () => {
    setupDb();
    const response = await fetch(`${baseUrl}/api/reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(10)}` },
        body: JSON.stringify({ medicationId: 1, times: ["08:00", "20:00"], weekdays: [1, 2, 3, 4, 5] })
    });
    assert.equal(response.status, 201);
    const data = await response.json();
    assert.deepEqual(data.reminder.times, ["08:00", "20:00"]);
    assert.deepEqual(data.reminder.weekdays, [1, 2, 3, 4, 5]);
    assert.equal(data.reminder.status, "active");
});

test("POST recusa medicamento de outro usuário com 404", async () => {
    setupDb();
    const response = await fetch(`${baseUrl}/api/reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(10)}` },
        body: JSON.stringify({ medicationId: 2, times: ["08:00"], weekdays: [] })
    });
    assert.equal(response.status, 404);
});

test("POST valida horários: formato, duplicata e limite de 12", async () => {
    setupDb();
    const token = tokenFor(10);
    const post = (body: unknown) => fetch(`${baseUrl}/api/reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
    });

    assert.equal((await post({ medicationId: 1, times: [], weekdays: [] })).status, 400);
    assert.equal((await post({ medicationId: 1, times: ["8:00"], weekdays: [] })).status, 400);
    assert.equal((await post({ medicationId: 1, times: ["08:00", "08:00"], weekdays: [] })).status, 400);
    assert.equal((await post({
        medicationId: 1,
        times: Array.from({ length: 13 }, (_, i) => `${String(i).padStart(2, "0")}:00`),
        weekdays: []
    })).status, 400);
});

test("POST valida dias da semana: fora de 0-6 e duplicata", async () => {
    setupDb();
    const token = tokenFor(10);
    const post = (body: unknown) => fetch(`${baseUrl}/api/reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
    });

    assert.equal((await post({ medicationId: 1, times: ["08:00"], weekdays: [7] })).status, 400);
    assert.equal((await post({ medicationId: 1, times: ["08:00"], weekdays: [1, 1] })).status, 400);
});

test("POST recusa ends_on anterior a starts_on", async () => {
    setupDb();
    const response = await fetch(`${baseUrl}/api/reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(10)}` },
        body: JSON.stringify({
            medicationId: 1, times: ["08:00"], weekdays: [], startsOn: "2024-02-10", endsOn: "2024-02-01"
        })
    });
    assert.equal(response.status, 400);
});

test("GET lista só os lembretes do usuário autenticado e devolve o fuso dele", async () => {
    setupDb();
    const tokenA = tokenFor(10);
    await fetch(`${baseUrl}/api/reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ medicationId: 1, times: ["08:00"], weekdays: [] })
    });

    const response = await fetch(`${baseUrl}/api/reminders`, { headers: { Authorization: `Bearer ${tokenA}` } });
    const data = await response.json();
    assert.equal(data.reminders.length, 1);
    assert.equal(data.timezone, "America/Sao_Paulo");

    const otherResponse = await fetch(`${baseUrl}/api/reminders`, { headers: { Authorization: `Bearer ${tokenFor(20)}` } });
    const otherData = await otherResponse.json();
    assert.equal(otherData.reminders.length, 0);
});

test("GET resposta não é cacheável (Cache-Control: no-store)", async () => {
    setupDb();
    const response = await fetch(`${baseUrl}/api/reminders`, { headers: { Authorization: `Bearer ${tokenFor(10)}` } });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("etag"), null);
});

test("PUT substitui horários/dias e DELETE remove; dono de outro usuário recebe 404", async () => {
    setupDb();
    const token = tokenFor(10);
    const created = await fetch(`${baseUrl}/api/reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ medicationId: 1, times: ["08:00", "20:00"], weekdays: [1, 2, 3, 4, 5] })
    }).then((r) => r.json());

    const updated = await fetch(`${baseUrl}/api/reminders/${created.reminder.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ times: ["09:00"], weekdays: [] })
    }).then((r) => r.json());
    assert.deepEqual(updated.reminder.times, ["09:00"]);
    assert.deepEqual(updated.reminder.weekdays, []);

    const forbiddenDelete = await fetch(`${baseUrl}/api/reminders/${created.reminder.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokenFor(20)}` }
    });
    assert.equal(forbiddenDelete.status, 404);

    const ownDelete = await fetch(`${baseUrl}/api/reminders/${created.reminder.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(ownDelete.status, 204);
});
