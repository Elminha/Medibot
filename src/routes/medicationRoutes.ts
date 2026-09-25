import { Router, type Request, type Response } from "express";
import { getCurrentUserId } from "../services/developmentUserService.js";
import {
    createMedication,
    deleteMedication,
    getMedicationById,
    listMedications,
    MedicationNotFoundError,
    updateMedication,
    type MedicationInput
} from "../services/medicationService.js";

const medicationRoutes = Router();

function parseMedicationId(value: unknown): number | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function validateMedicationInput(body: unknown): MedicationInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }

    const { name, dosage, instructions, active } = body as Record<string, unknown>;

    if (typeof name !== "string" || !name.trim()) {
        return undefined;
    }

    if (dosage !== undefined && dosage !== null && typeof dosage !== "string") {
        return undefined;
    }

    if (instructions !== undefined && instructions !== null && typeof instructions !== "string") {
        return undefined;
    }

    if (active !== undefined && typeof active !== "boolean") {
        return undefined;
    }

    return {
        name: name.trim(),
        dosage,
        instructions,
        active
    };
}

function sendError(response: Response, error: unknown): Response | undefined {
    if (error instanceof MedicationNotFoundError) {
        return response.status(404).json({ error: error.message });
    }

    return undefined;
}

medicationRoutes.post("/", async (request: Request, response: Response) => {
    const input = validateMedicationInput(request.body);

    if (!input) {
        return response.status(400).json({
            error: "O campo 'name' \u00e9 obrigat\u00f3rio e deve ser uma string n\u00e3o vazia."
        });
    }

    try {
        const medication = await createMedication(await getCurrentUserId(), input);
        return response.status(201).json({ medication });
    } catch {
        return response.status(500).json({ error: "N\u00e3o foi poss\u00edvel cadastrar o medicamento." });
    }
});

medicationRoutes.get("/", async (_request: Request, response: Response) => {
    try {
        const medications = await listMedications(await getCurrentUserId());
        return response.json({ medications });
    } catch {
        return response.status(500).json({ error: "N\u00e3o foi poss\u00edvel listar os medicamentos." });
    }
});

medicationRoutes.get("/:id", async (request: Request, response: Response) => {
    const id = parseMedicationId(request.params.id);

    if (!id) {
        return response.status(400).json({ error: "O ID do medicamento deve ser um inteiro positivo." });
    }

    try {
        const medication = await getMedicationById(await getCurrentUserId(), id);
        return response.json({ medication });
    } catch (error) {
        return sendError(response, error)
            ?? response.status(500).json({ error: "N\u00e3o foi poss\u00edvel buscar o medicamento." });
    }
});

medicationRoutes.put("/:id", async (request: Request, response: Response) => {
    const id = parseMedicationId(request.params.id);

    if (!id) {
        return response.status(400).json({ error: "O ID do medicamento deve ser um inteiro positivo." });
    }

    const input = validateMedicationInput(request.body);

    if (!input) {
        return response.status(400).json({
            error: "O campo 'name' \u00e9 obrigat\u00f3rio e deve ser uma string n\u00e3o vazia."
        });
    }

    try {
        const medication = await updateMedication(await getCurrentUserId(), id, input);
        return response.json({ medication });
    } catch (error) {
        return sendError(response, error)
            ?? response.status(500).json({ error: "N\u00e3o foi poss\u00edvel atualizar o medicamento." });
    }
});

medicationRoutes.delete("/:id", async (request: Request, response: Response) => {
    const id = parseMedicationId(request.params.id);

    if (!id) {
        return response.status(400).json({ error: "O ID do medicamento deve ser um inteiro positivo." });
    }

    try {
        await deleteMedication(await getCurrentUserId(), id);
        return response.status(204).send();
    } catch (error) {
        return sendError(response, error)
            ?? response.status(500).json({ error: "N\u00e3o foi poss\u00edvel excluir o medicamento." });
    }
});

export default medicationRoutes;
