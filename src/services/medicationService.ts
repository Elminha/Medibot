import { getDatabasePool } from "../database/database.js";

export interface Medication {
    id: number;
    name: string;
    dosage: string | null;
    instructions: string | null;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface MedicationInput {
    name: string;
    dosage?: string | null;
    instructions?: string | null;
    active?: boolean;
}

interface MedicationRow {
    id: string;
    user_id: string;
    name: string;
    dosage: string | null;
    instructions: string | null;
    active: boolean;
    created_at: Date;
    updated_at: Date;
}

export class MedicationNotFoundError extends Error {
    constructor() {
        super("Medicamento n\u00e3o encontrado.");
        this.name = "MedicationNotFoundError";
    }
}

function toMedication(row: MedicationRow): Medication {
    return {
        id: Number(row.id),
        name: row.name,
        dosage: row.dosage,
        instructions: row.instructions,
        active: row.active,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

export async function createMedication(
    userId: number,
    input: MedicationInput
): Promise<Medication> {
    const result = await getDatabasePool().query<MedicationRow>(
        `INSERT INTO medications (user_id, name, dosage, instructions, active)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, name, dosage, instructions, active, created_at, updated_at;`,
        [
            userId,
            input.name,
            input.dosage ?? null,
            input.instructions ?? null,
            input.active ?? true
        ]
    );

    return toMedication(result.rows[0]);
}

export async function listMedications(userId: number): Promise<Medication[]> {
    const result = await getDatabasePool().query<MedicationRow>(
        `SELECT id, user_id, name, dosage, instructions, active, created_at, updated_at
         FROM medications
         WHERE user_id = $1
         ORDER BY id ASC;`,
        [userId]
    );

    return result.rows.map(toMedication);
}

export async function getMedicationById(userId: number, id: number): Promise<Medication> {
    const result = await getDatabasePool().query<MedicationRow>(
        `SELECT id, user_id, name, dosage, instructions, active, created_at, updated_at
         FROM medications
         WHERE id = $1 AND user_id = $2;`,
        [id, userId]
    );

    if (!result.rows[0]) {
        throw new MedicationNotFoundError();
    }

    return toMedication(result.rows[0]);
}

export async function updateMedication(
    userId: number,
    id: number,
    input: MedicationInput
): Promise<Medication> {
    await getMedicationById(userId, id);

    const result = await getDatabasePool().query<MedicationRow>(
        `UPDATE medications
         SET name = $1,
             dosage = $2,
             instructions = $3,
             active = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 AND user_id = $6
         RETURNING id, user_id, name, dosage, instructions, active, created_at, updated_at;`,
        [
            input.name,
            input.dosage ?? null,
            input.instructions ?? null,
            input.active ?? true,
            id,
            userId
        ]
    );

    if (!result.rows[0]) {
        throw new MedicationNotFoundError();
    }

    return toMedication(result.rows[0]);
}

export async function deleteMedication(userId: number, id: number): Promise<void> {
    await getMedicationById(userId, id);

    const result = await getDatabasePool().query(
        "DELETE FROM medications WHERE id = $1 AND user_id = $2;",
        [id, userId]
    );

    if (result.rowCount === 0) {
        throw new MedicationNotFoundError();
    }
}
