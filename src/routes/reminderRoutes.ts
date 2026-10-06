import { Router, type Response } from "express";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { MedicationNotFoundError } from "../services/medicationService.js";
import {
    createReminder,
    deleteReminder,
    getReminderById,
    listReminders,
    ReminderNotFoundError,
    REMINDER_FREQUENCIES,
    updateReminder,
    type ReminderFrequency,
    type ReminderInput,
    type ReminderUpdateInput
} from "../services/reminderService.js";

const reminderRoutes = Router();

reminderRoutes.use(requireAuthentication);

function getAuthenticatedUserId(request: AuthenticatedRequest): number {
    return request.auth!.userId;
}

function parsePositiveInteger(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        return undefined;
    }

    return value;
}

function parseReminderId(value: unknown): number | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    return parsePositiveInteger(Number(value));
}

function isValidTime(value: unknown): value is string {
    return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isValidFrequency(value: unknown): value is ReminderFrequency {
    return typeof value === "string" && REMINDER_FREQUENCIES.includes(value as ReminderFrequency);
}

function isValidActive(value: unknown): value is boolean {
    return typeof value === "boolean";
}

function validateReminderInput(body: unknown): ReminderInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }

    const { medicationId, time, frequency, active } = body as Record<string, unknown>;
    const validMedicationId = parsePositiveInteger(medicationId);

    if (!validMedicationId || !isValidTime(time) || !isValidFrequency(frequency)) {
        return undefined;
    }

    if (active !== undefined && !isValidActive(active)) {
        return undefined;
    }

    return { medicationId: validMedicationId, time, frequency, active };
}

function validateReminderUpdate(body: unknown): ReminderUpdateInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }

    const { medicationId, time, frequency, active } = body as Record<string, unknown>;
    const hasUpdate = medicationId !== undefined || time !== undefined
        || frequency !== undefined || active !== undefined;

    if (!hasUpdate) {
        return undefined;
    }

    if (medicationId !== undefined && !parsePositiveInteger(medicationId)) {
        return undefined;
    }

    if (time !== undefined && !isValidTime(time)) {
        return undefined;
    }

    if (frequency !== undefined && !isValidFrequency(frequency)) {
        return undefined;
    }

    if (active !== undefined && !isValidActive(active)) {
        return undefined;
    }

    return {
        medicationId: medicationId as number | undefined,
        time: time as string | undefined,
        frequency: frequency as ReminderFrequency | undefined,
        active: active as boolean | undefined
    };
}

function sendError(response: Response, error: unknown): Response | undefined {
    if (error instanceof ReminderNotFoundError || error instanceof MedicationNotFoundError) {
        return response.status(404).json({ error: error.message });
    }

    return undefined;
}

function invalidReminderResponse(response: Response): Response {
    return response.status(400).json({
        error: "Informe medicationId, time (HH:MM) e frequency v\u00e1lidos."
    });
}

reminderRoutes.post("/", async (request: AuthenticatedRequest, response: Response) => {
    const input = validateReminderInput(request.body);

    if (!input) {
        return invalidReminderResponse(response);
    }

    try {
        const reminder = await createReminder(getAuthenticatedUserId(request), input);
        return response.status(201).json({ reminder });
    } catch (error) {
        return sendError(response, error)
            ?? response.status(500).json({ error: "N\u00e3o foi poss\u00edvel cadastrar o lembrete." });
    }
});

reminderRoutes.get("/", async (request: AuthenticatedRequest, response: Response) => {
    try {
        const reminders = await listReminders(getAuthenticatedUserId(request));
        return response.json({ reminders });
    } catch {
        return response.status(500).json({ error: "N\u00e3o foi poss\u00edvel listar os lembretes." });
    }
});

reminderRoutes.get("/:id", async (request: AuthenticatedRequest, response: Response) => {
    const id = parseReminderId(request.params.id);

    if (!id) {
        return response.status(400).json({ error: "O ID do lembrete deve ser um inteiro positivo." });
    }

    try {
        const reminder = await getReminderById(getAuthenticatedUserId(request), id);
        return response.json({ reminder });
    } catch (error) {
        return sendError(response, error)
            ?? response.status(500).json({ error: "N\u00e3o foi poss\u00edvel buscar o lembrete." });
    }
});

reminderRoutes.put("/:id", async (request: AuthenticatedRequest, response: Response) => {
    const id = parseReminderId(request.params.id);

    if (!id) {
        return response.status(400).json({ error: "O ID do lembrete deve ser um inteiro positivo." });
    }

    const input = validateReminderUpdate(request.body);

    if (!input) {
        return invalidReminderResponse(response);
    }

    try {
        const reminder = await updateReminder(getAuthenticatedUserId(request), id, input);
        return response.json({ reminder });
    } catch (error) {
        return sendError(response, error)
            ?? response.status(500).json({ error: "N\u00e3o foi poss\u00edvel atualizar o lembrete." });
    }
});

reminderRoutes.delete("/:id", async (request: AuthenticatedRequest, response: Response) => {
    const id = parseReminderId(request.params.id);

    if (!id) {
        return response.status(400).json({ error: "O ID do lembrete deve ser um inteiro positivo." });
    }

    try {
        await deleteReminder(getAuthenticatedUserId(request), id);
        return response.status(204).send();
    } catch (error) {
        return sendError(response, error)
            ?? response.status(500).json({ error: "N\u00e3o foi poss\u00edvel excluir o lembrete." });
    }
});

export default reminderRoutes;
