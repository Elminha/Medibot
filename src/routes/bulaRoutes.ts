import { Router, type Response } from "express";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { consultarBula } from "../services/bulaService.js";
import { saveQuery } from "../services/queryHistoryService.js";

const bulaRoutes = Router();

bulaRoutes.use(requireAuthentication);

bulaRoutes.post("/", async (request: AuthenticatedRequest, response: Response) => {
    const { question } = request.body as { question?: unknown };

    if (typeof question !== "string" || !question.trim()) {
        return response.status(400).json({
            error: "O campo 'question' é obrigatório e deve ser uma string não vazia."
        });
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
            resultado.sources
        );
    } catch (error) {
        console.error("Não foi possível salvar o histórico da consulta.", error);
    }

    return response.json(resultado);
});

export default bulaRoutes;
