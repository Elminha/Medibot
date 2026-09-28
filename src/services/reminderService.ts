import { getDatabasePool } from "../database/database.js";
import { getMedicationById } from "./medicationService.js";

export const REMINDER_FREQUENCIES = ["daily", "weekly", "weekdays", "custom"] as const;

export type ReminderFrequency = (typeof REMINDER_FREQUENCIES)[number];

export interface Reminder {
    id: number;
    medicationId: number;
    medicationName: string;
    time: string;
    frequency: ReminderFrequency;
    active: boolean;
}

export interface ReminderInput {
    medicationId: number;
    time: string;
    frequency: ReminderFrequency;
    active?: boolean;
}

export interface ReminderUpdateInput {
    medicationId?: number;
    time?: string;
    frequency?: ReminderFrequency;
    active?: boolean;
}

interface ReminderRow {
    id: string;
    medication_id: string;
    medication_name: string;
    time: string;
    frequency: ReminderFrequency;
    active: boolean;
}

export class ReminderNotFoundError extends Error {
    constructor() {
        super("Lembrete n\u00e3o encontrado.");
        this.name = "ReminderNotFoundError";
    }
}

function toReminder(row: ReminderRow): Reminder {
    return {
        id: Number(row.id),
        medicationId: Number(row.medication_id),
        medicationName: row.medication_name,
        time: row.time.slice(0, 5),
        frequency: row.frequency,
        active: row.active
    };
}

export async function createReminder(userId: number, input: ReminderInput): Promise<Reminder> {
    await getMedicationById(userId, input.medicationId);

    const result = await getDatabasePool().query<{ id: string }>(
        `INSERT INTO reminders (medication_id, "time", frequency, active)
         VALUES ($1, $2, $3, $4)
         RETURNING id;`,
        [input.medicationId, input.time, input.frequency, input.active ?? true]
    );

    return getReminderById(userId, Number(result.rows[0].id));
}

export async function listReminders(userId: number): Promise<Reminder[]> {
    const result = await getDatabasePool().query<ReminderRow>(
        `SELECT r.id, r.medication_id, m.name AS medication_name, r."time", r.frequency, r.active
         FROM reminders r
         INNER JOIN medications m ON m.id = r.medication_id
         WHERE m.user_id = $1
         ORDER BY r."time" ASC, r.id ASC;`,
        [userId]
    );

    return result.rows.map(toReminder);
}

export async function getReminderById(userId: number, id: number): Promise<Reminder> {
    const result = await getDatabasePool().query<ReminderRow>(
        `SELECT r.id, r.medication_id, m.name AS medication_name, r."time", r.frequency, r.active
         FROM reminders r
         INNER JOIN medications m ON m.id = r.medication_id
         WHERE r.id = $1 AND m.user_id = $2;`,
        [id, userId]
    );

    if (!result.rows[0]) {
        throw new ReminderNotFoundError();
    }

    return toReminder(result.rows[0]);
}

export async function updateReminder(
    userId: number,
    id: number,
    input: ReminderUpdateInput
): Promise<Reminder> {
    const currentReminder = await getReminderById(userId, id);
    const medicationId = input.medicationId ?? currentReminder.medicationId;

    if (input.medicationId !== undefined) {
        await getMedicationById(userId, medicationId);
    }

    const result = await getDatabasePool().query(
        `UPDATE reminders
         SET medication_id = $1,
             "time" = $2,
             frequency = $3,
             active = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5
         RETURNING id;`,
        [
            medicationId,
            input.time ?? currentReminder.time,
            input.frequency ?? currentReminder.frequency,
            input.active ?? currentReminder.active,
            id
        ]
    );

    if (result.rowCount === 0) {
        throw new ReminderNotFoundError();
    }

    return getReminderById(userId, id);
}

export async function deleteReminder(userId: number, id: number): Promise<void> {
    await getReminderById(userId, id);

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
