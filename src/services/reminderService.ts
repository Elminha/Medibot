import { getDatabasePool } from "../database/database.js";
import { getMedicationById } from "./medicationService.js";

const WEEKDAYS_MON_TO_FRI = [1, 2, 3, 4, 5];

export type ReminderStatus = "active" | "paused" | "ended";

export interface Reminder {
    id: number;
    medicationId: number;
    medicationName: string;
    times: string[];
    weekdays: number[];
    startsOn: string;
    endsOn: string | null;
    active: boolean;
    status: ReminderStatus;
    channels: string[];
}

export interface ReminderInput {
    medicationId: number;
    times: string[];
    weekdays: number[];
    startsOn?: string;
    endsOn?: string | null;
    active?: boolean;
}

export interface ReminderUpdateInput {
    medicationId?: number;
    times?: string[];
    weekdays?: number[];
    startsOn?: string;
    endsOn?: string | null;
    active?: boolean;
}

interface ReminderRow {
    id: string;
    medication_id: string;
    medication_name: string;
    active: boolean;
    starts_on: string;
    ends_on: string | null;
    times: string[] | null;
    weekdays: number[] | null;
}

export class ReminderNotFoundError extends Error {
    constructor() {
        super("Lembrete não encontrado.");
        this.name = "ReminderNotFoundError";
    }
}

/** Data de hoje (YYYY-MM-DD) no fuso do usuário, nunca no fuso do servidor (UTC). */
export function todayInTimezone(timezone: string, now: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(now);
    const lookup = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

/** Frequência "legada" equivalente, mantida só para compatibilidade com um rollback. */
function legacyFrequency(weekdays: number[]): "daily" | "weekdays" {
    const uniqueSorted = [...new Set(weekdays)].sort((a, b) => a - b);
    const isMonToFri = uniqueSorted.length === WEEKDAYS_MON_TO_FRI.length
        && uniqueSorted.every((day, index) => day === WEEKDAYS_MON_TO_FRI[index]);
    return isMonToFri ? "weekdays" : "daily";
}

function statusOf(row: { active: boolean; endsOn: string | null }, today: string): ReminderStatus {
    if (row.endsOn !== null && row.endsOn < today) {
        return "ended";
    }
    return row.active ? "active" : "paused";
}

function toReminder(row: ReminderRow, today: string): Reminder {
    const times = (row.times ?? []).map((time) => time.slice(0, 5));
    const weekdays = [...new Set(row.weekdays ?? [])].sort((a, b) => a - b);
    const endsOn = row.ends_on;

    return {
        id: Number(row.id),
        medicationId: Number(row.medication_id),
        medicationName: row.medication_name,
        times,
        weekdays,
        startsOn: row.starts_on,
        endsOn,
        active: row.active,
        status: statusOf({ active: row.active, endsOn }, today),
        channels: ["browser"]
    };
}

const SELECT_REMINDER_COLUMNS = `
    r.id,
    r.medication_id,
    m.name AS medication_name,
    r.active,
    r.starts_on,
    r.ends_on,
    COALESCE(
        (SELECT array_agg(to_char(rt."time", 'HH24:MI') ORDER BY rt."time")
         FROM reminder_times rt WHERE rt.reminder_id = r.id),
        '{}'
    ) AS times,
    COALESCE(
        (SELECT array_agg(rw.weekday ORDER BY rw.weekday)
         FROM reminder_weekdays rw WHERE rw.reminder_id = r.id),
        '{}'
    ) AS weekdays
`;

async function insertScheduleRows(
    client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
    reminderId: number,
    times: string[],
    weekdays: number[]
): Promise<void> {
    for (const time of times) {
        await client.query(
            `INSERT INTO reminder_times (reminder_id, "time") VALUES ($1, $2);`,
            [reminderId, time]
        );
    }
    for (const weekday of weekdays) {
        await client.query(
            `INSERT INTO reminder_weekdays (reminder_id, weekday) VALUES ($1, $2);`,
            [reminderId, weekday]
        );
    }
}

export async function createReminder(
    userId: number,
    input: ReminderInput,
    timezone: string
): Promise<Reminder> {
    await getMedicationById(userId, input.medicationId);

    const sortedTimes = [...input.times].sort();
    const firstTime = sortedTimes[0];
    const frequency = legacyFrequency(input.weekdays);
    const startsOn = input.startsOn ?? todayInTimezone(timezone);
    const endsOn = input.endsOn ?? null;
    const active = input.active ?? true;

    const pool = getDatabasePool();
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const result = await client.query<{ id: string }>(
            `INSERT INTO reminders (medication_id, "time", frequency, active, starts_on, ends_on)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id;`,
            [input.medicationId, firstTime, frequency, active, startsOn, endsOn]
        );
        const reminderId = Number(result.rows[0].id);

        await insertScheduleRows(client, reminderId, sortedTimes, input.weekdays);

        await client.query("COMMIT");
        return getReminderById(userId, reminderId, timezone);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function listReminders(userId: number, timezone: string): Promise<Reminder[]> {
    const result = await getDatabasePool().query<ReminderRow>(
        `SELECT ${SELECT_REMINDER_COLUMNS}
         FROM reminders r
         INNER JOIN medications m ON m.id = r.medication_id
         WHERE m.user_id = $1
         ORDER BY r.id ASC;`,
        [userId]
    );

    const today = todayInTimezone(timezone);
    return result.rows.map((row) => toReminder(row, today));
}

export async function getReminderById(
    userId: number,
    id: number,
    timezone: string
): Promise<Reminder> {
    const result = await getDatabasePool().query<ReminderRow>(
        `SELECT ${SELECT_REMINDER_COLUMNS}
         FROM reminders r
         INNER JOIN medications m ON m.id = r.medication_id
         WHERE r.id = $1 AND m.user_id = $2;`,
        [id, userId]
    );

    if (!result.rows[0]) {
        throw new ReminderNotFoundError();
    }

    return toReminder(result.rows[0], todayInTimezone(timezone));
}

export async function updateReminder(
    userId: number,
    id: number,
    input: ReminderUpdateInput,
    timezone: string
): Promise<Reminder> {
    const current = await getReminderById(userId, id, timezone);
    const medicationId = input.medicationId ?? current.medicationId;

    if (input.medicationId !== undefined) {
        await getMedicationById(userId, medicationId);
    }

    const times = input.times ?? current.times;
    const weekdays = input.weekdays ?? current.weekdays;
    const sortedTimes = [...times].sort();
    const firstTime = sortedTimes[0];
    const frequency = legacyFrequency(weekdays);
    const startsOn = input.startsOn ?? current.startsOn;
    const endsOn = input.endsOn !== undefined ? input.endsOn : current.endsOn;
    const active = input.active ?? current.active;

    const pool = getDatabasePool();
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const result = await client.query(
            `UPDATE reminders
             SET medication_id = $1,
                 "time" = $2,
                 frequency = $3,
                 active = $4,
                 starts_on = $5,
                 ends_on = $6,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $7
             RETURNING id;`,
            [medicationId, firstTime, frequency, active, startsOn, endsOn, id]
        );

        if (result.rowCount === 0) {
            throw new ReminderNotFoundError();
        }

        await client.query(`DELETE FROM reminder_times WHERE reminder_id = $1;`, [id]);
        await client.query(`DELETE FROM reminder_weekdays WHERE reminder_id = $1;`, [id]);
        await insertScheduleRows(client, id, sortedTimes, weekdays);

        await client.query("COMMIT");
        return getReminderById(userId, id, timezone);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function deleteReminder(userId: number, id: number): Promise<void> {
    await getReminderById(userId, id, "UTC");

    const result = await getDatabasePool().query(
        `DELETE FROM reminders
         WHERE id = $1
           AND medication_id IN (SELECT id FROM medications WHERE user_id = $2);`,
        [id, userId]
    );

    if (result.rowCount === 0) {
        throw new ReminderNotFoundError();
    }
}
