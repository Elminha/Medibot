import { Router, type Response } from "express";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { MedicationNotFoundError } from "../services/medicationService.js";
import {
    createReminder,
    deleteReminder,
    getReminderById,
    listReminders,
    ReminderNotFoundError,
    updateReminder,
    type ReminderInput,
    type ReminderUpdateInput
} from "../services/reminderService.js";

const reminderRoutes = Router();
const MAX_TIMES_PER_REMINDER = 12;

reminderRoutes.use(requireAuthentication);

function getAuthenticatedUserId(request: AuthenticatedRequest): number {
    return request.auth!.userId;
}

function getAuthenticatedTimezone(request: AuthenticatedRequest): string {
    return request.auth!.user.timezone;
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

function isValidDate(value: unknown): value is string {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isValidActive(value: unknown): value is boolean {
    return typeof value === "boolean";
}

function parseTimes(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TIMES_PER_REMINDER) {
        return undefined;
    }

    if (!value.every(isValidTime)) {
        return undefined;
    }

    if (new Set(value).size !== value.length) {
        return undefined;
    }

    return value as string[];
}

function parseWeekdays(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const isValidWeekday = (item: unknown): item is number =>
        typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 6;

    if (!value.every(isValidWeekday)) {
        return undefined;
    }

    if (new Set(value).size !== value.length) {
        return undefined;
    }

    return value as number[];
}

function parseEndsOn(value: unknown): string | null | undefined {
    if (value === null) {
        return null;
    }

    return isValidDate(value) ? value : undefined;
}

function validateReminderInput(body: unknown): ReminderInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }

    const { medicationId, times, weekdays, startsOn, endsOn, active } = body as Record<string, unknown>;
    const validMedicationId = parsePositiveInteger(medicationId);
    const validTimes = parseTimes(times);
    const validWeekdays = weekdays === undefined ? [] : parseWeekdays(weekdays);

    if (!validMedicationId || !validTimes || !validWeekdays) {
        return undefined;
    }

    if (startsOn !== undefined && !isValidDate(startsOn)) {
        return undefined;
    }

    let validEndsOn: string | null | undefined = undefined;
    if (endsOn !== undefined) {
        validEndsOn = parseEndsOn(endsOn);
        if (validEndsOn === undefined) {
            return undefined;
        }
    }

    if (active !== undefined && !isValidActive(active)) {
        return undefined;
    }

    return {
        medicationId: validMedicationId,
        times: validTimes,
        weekdays: validWeekdays,
        startsOn: startsOn as string | undefined,
        endsOn: validEndsOn,
        active: active as boolean | undefined
    };
}

function validateReminderUpdate(body: unknown): ReminderUpdateInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }

    const { medicationId, times, weekdays, startsOn, endsOn, active } = body as Record<string, unknown>;
    const hasUpdate = medicationId !== undefined || times !== undefined || weekdays !== undefined
        || startsOn !== undefined || endsOn !== undefined || active !== undefined;

    if (!hasUpdate) {
        return undefined;
    }

    if (medicationId !== undefined && !parsePositiveInteger(medicationId)) {
        return undefined;
    }

    let validTimes: string[] | undefined;
    if (times !== undefined) {
        validTimes = parseTimes(times);
        if (!validTimes) {
            return undefined;
        }
    }

    let validWeekdays: number[] | undefined;
    if (weekdays !== undefined) {
        validWeekdays = parseWeekdays(weekdays);
        if (!validWeekdays) {
            return undefined;
        }
    }

    if (startsOn !== undefined && !isValidDate(startsOn)) {
        return undefined;
    }

    let validEndsOn: string | null | undefined;
    if (endsOn !== undefined) {
        validEndsOn = parseEndsOn(endsOn);
        if (validEndsOn === undefined) {
            return undefined;
        }
    }

    if (active !== undefined && !isValidActive(active)) {
        return undefined;
    }

    return {
        medicationId: medicationId as number | undefined,
        times: validTimes,
        weekdays: validWeekdays,
        startsOn: startsOn as string | undefined,
        endsOn: validEndsOn,
        active: active as boolean | undefined
    };
}

function isCheckViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error
        && (error as { code: unknown }).code === "23514";
}

function sendError(response: Response, error: unknown): Response | undefined {
    if (error instanceof ReminderNotFoundError || error instanceof MedicationNotFoundError) {
        return response.status(404).json({ error: error.message });
    }

    if (isCheckViolation(error)) {
        return response.status(400).json({
            error: "A data de término deve ser igual ou posterior à data de início."
        });
    }

    return undefined;
}

function invalidReminderResponse(response: Response): Response {
    return response.status(400).json({
        error: "Informe medicationId, de 1 a 12 horários (HH:MM, sem repetir) e dias da semana "
            + "válidos (0 a 6, sem repetir; vazio significa todos os dias)."
    });
}

reminderRoutes.post("/", async (request: AuthenticatedRequest, response: Response) => {
    const input = validateReminderInput(request.body);

    if (!input) {
        return invalidReminderResponse(response);
    }

    try {
        const reminder = await createReminder(
            getAuthenticatedUserId(request),
            input,
            getAuthenticatedTimezone(request)
        );
        return response.status(201).json({ reminder });
    } catch (error) {
        return sendError(response, error)
            ?? response.status(500).json({ error: "Não foi possível cadastrar o lembrete." });
    }
});

reminderRoutes.get("/", async (request: AuthenticatedRequest, response: Response) => {
    const timezone = getAuthenticatedTimezone(request);

    try {
        const reminders = await listReminders(getAuthenticatedUserId(request), timezone);
        return response.json({ reminders, timezone });
    } catch {
        return response.status(500).json({ error: "Não foi possível listar os lembretes." });
    }
});

reminderRoutes.get("/:id", async (request: AuthenticatedRequest, response: Response) => {
    const id = parseReminderId(request.params.id);

    if (!id) {
        return response.status(400).json({ error: "O ID do lembrete deve ser um inteiro positivo." });
    }

    try {
        const reminder = await getReminderById(getAuthenticatedUserId(request), id, getAuthenticatedTimezone(request));
        return response.json({ reminder });
    } catch (error) {
        return sendError(response, error)
            ?? response.status(500).json({ error: "Não foi possível buscar o lembrete." });
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
        const reminder = await updateReminder(
            getAuthenticatedUserId(request),
            id,
            input,
            getAuthenticatedTimezone(request)
        );
        return response.json({ reminder });
    } catch (error) {
        return sendError(response, error)
            ?? response.status(500).json({ error: "Não foi possível atualizar o lembrete." });
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
            ?? response.status(500).json({ error: "Não foi possível excluir o lembrete." });
    }
});

export default reminderRoutes;
