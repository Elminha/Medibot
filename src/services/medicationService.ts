import { getDatabasePool } from "../database/database.js";
import {
    decryptField,
    decryptOptionalField,
    encryptField,
    encryptOptionalField,
    isEncrypted
} from "./fieldEncryption.js";

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
        name: decryptField("medications.name", row.name),
        dosage: decryptOptionalField("medications.dosage", row.dosage),
        instructions: decryptOptionalField("medications.instructions", row.instructions),
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
            encryptField("medications.name", input.name),
            encryptOptionalField("medications.dosage", input.dosage),
            encryptOptionalField("medications.instructions", input.instructions),
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
            encryptField("medications.name", input.name),
            encryptOptionalField("medications.dosage", input.dosage),
            encryptOptionalField("medications.instructions", input.instructions),
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

interface LegacyMedicationRow {
    id: string;
    name: string;
    dosage: string | null;
    instructions: string | null;
}

export interface MedicationEncryptionPool {
    query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * Cifra, em lotes, os medicamentos gravados em texto puro antes da cifragem existir.
 * Roda junto com o despachante de lembretes (a cada minuto, em produção), então os
 * registros antigos são migrados sozinhos, sem script manual contra o banco.
 * O UPDATE só acontece se o registro não mudou desde a leitura (edição concorrente
 * do usuário vence). Devolve quantos registros foram cifrados.
 */
export async function encryptLegacyMedications(
    pool: MedicationEncryptionPool,
    limit = 50
): Promise<number> {
    const result = await pool.query<LegacyMedicationRow>(
        `SELECT id, name, dosage, instructions
         FROM medications
         WHERE name NOT LIKE 'enc:v1:%'
            OR (dosage IS NOT NULL AND dosage NOT LIKE 'enc:v1:%')
            OR (instructions IS NOT NULL AND instructions NOT LIKE 'enc:v1:%')
         ORDER BY id ASC
         LIMIT $1;`,
        [limit]
    );

    let encrypted = 0;
    for (const row of result.rows) {
        const name = isEncrypted(row.name) ? row.name : encryptField("medications.name", row.name);
        const dosage = row.dosage === null || isEncrypted(row.dosage)
            ? row.dosage
            : encryptField("medications.dosage", row.dosage);
        const instructions = row.instructions === null || isEncrypted(row.instructions)
            ? row.instructions
            : encryptField("medications.instructions", row.instructions);

        const update = await pool.query(
            `UPDATE medications
             SET name = $1, dosage = $2, instructions = $3
             WHERE id = $4
               AND name = $5
               AND dosage IS NOT DISTINCT FROM $6
               AND instructions IS NOT DISTINCT FROM $7;`,
            [name, dosage, instructions, row.id, row.name, row.dosage, row.instructions]
        );
        encrypted += update.rowCount ?? 0;
    }
    return encrypted;
}
