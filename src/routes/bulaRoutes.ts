import { Router, type Response } from "express";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { consultarBula } from "../services/bulaService.js";
import { saveQuery } from "../services/queryHistoryService.js";

const bulaRoutes = Router();

bulaRoutes.use(requireAuthentication);

function getRequestId(value: string | undefined): string | undefined {
    return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
        ? value
        : undefined;
}

bulaRoutes.post("/", async (request: AuthenticatedRequest, response: Response) => {
    const { question } = request.body as { question?: unknown };
    const requestId = getRequestId(request.header("x-idempotency-key"));

    if (typeof question !== "string" || !question.trim()) {
        return response.status(400).json({
            error: "O campo 'question' é obrigatório e deve ser uma string não vazia."
        });
    }

    if (!requestId) {
        return response.status(400).json({ error: "A chave de idempotência da consulta é obrigatória." });
    }

    const normalizedQuestion = question.trim();
    let resultado;

    try {
        resultado = await consultarBula(normalizedQuestion);
    } catch {
        return response.status(500).json({
            error: "Não foi possível consultar a bula no momento. Tente novamente mais tarde."
        });
    }

    try {
        await saveQuery(
            request.auth!.userId,
            normalizedQuestion,
            resultado.answer,
            resultado.sources,
            requestId
        );
    } catch (error) {
        console.error("Não foi possível salvar o histórico da consulta.", error);
    }

    return response.json(resultado);
});

export default bulaRoutes;
