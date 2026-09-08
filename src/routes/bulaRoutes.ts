import { Router, type Request, type Response } from "express";
import { consultarBula } from "../services/bulaService.js";

const bulaRoutes = Router();

bulaRoutes.post("/", async (request: Request, response: Response) => {
    const { question } = request.body as { question?: unknown };

    if (typeof question !== "string" || !question.trim()) {
        return response.status(400).json({
            error: "O campo 'question' é obrigatório e deve ser uma string não vazia."
        });
    }

    try {
        const resultado = await consultarBula(question);
        return response.json(resultado);
    } catch {
        return response.status(500).json({
            error: "Não foi possível consultar a bula no momento. Tente novamente mais tarde."
        });
    }
});

export default bulaRoutes;
