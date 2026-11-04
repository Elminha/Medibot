import { Router, type Response } from "express";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import {
    createFeedback,
    FeedbackRateLimitError,
    isFeedbackDevice,
    isFeedbackType,
    isFeedbackView,
    isValidFeedbackRating,
    validateFeedbackMessage,
    type FeedbackInput
} from "../services/feedbackService.js";

const feedbackRoutes = Router();

feedbackRoutes.use(requireAuthentication);

function getAuthenticatedUserId(request: AuthenticatedRequest): number {
    return request.auth!.userId;
}

function validateFeedbackInput(body: unknown): FeedbackInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }

    const { type, rating, message, view, device, contactOk } = body as Record<string, unknown>;

    if (!isFeedbackType(type) || !isFeedbackView(view) || !isFeedbackDevice(device)) {
        return undefined;
    }

    const validMessage = validateFeedbackMessage(message);
    if (!validMessage) {
        return undefined;
    }

    if (rating !== undefined && rating !== null && !isValidFeedbackRating(rating)) {
        return undefined;
    }

    if (contactOk !== undefined && typeof contactOk !== "boolean") {
        return undefined;
    }

    return {
        type,
        rating: isValidFeedbackRating(rating) ? rating : undefined,
        message: validMessage,
        view,
        device,
        contactOk: contactOk === true
    };
}

feedbackRoutes.post("/", async (request: AuthenticatedRequest, response: Response) => {
    const input = validateFeedbackInput(request.body);

    if (!input) {
        return response.status(400).json({
            error: "Informe um tipo válido (bug, sugestao, elogio ou outro), uma mensagem de 1 a 2000 "
                + "caracteres, a tela atual e o dispositivo (mobile ou desktop)."
        });
    }

    try {
        await createFeedback(getAuthenticatedUserId(request), input);
        return response.status(201).json({ ok: true });
    } catch (error) {
        if (error instanceof FeedbackRateLimitError) {
            return response.status(429).json({ error: error.message });
        }
        // Nunca registrar o corpo da requisição aqui: pode conter o texto do feedback.
        console.error("Falha ao registrar feedback.");
        return response.status(500).json({ error: "Não foi possível enviar seu feedback." });
    }
});

export default feedbackRoutes;
