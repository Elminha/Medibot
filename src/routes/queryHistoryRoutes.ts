import { Router, type Response } from "express";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import {
    getQueryById,
    listQueries,
    QueryNotFoundError
} from "../services/queryHistoryService.js";

const queryHistoryRoutes = Router();

queryHistoryRoutes.use(requireAuthentication);

function getAuthenticatedUserId(request: AuthenticatedRequest): number {
    return request.auth!.userId;
}

function parseQueryId(value: unknown): number | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

queryHistoryRoutes.get("/", async (request: AuthenticatedRequest, response: Response) => {
    try {
        const queries = await listQueries(getAuthenticatedUserId(request));
        return response.json({ queries });
    } catch {
        return response.status(500).json({ error: "Não foi possível listar o histórico de consultas." });
    }
});

queryHistoryRoutes.get("/:id", async (request: AuthenticatedRequest, response: Response) => {
    const id = parseQueryId(request.params.id);

    if (!id) {
        return response.status(400).json({ error: "O ID da consulta deve ser um inteiro positivo." });
    }

    try {
        const query = await getQueryById(getAuthenticatedUserId(request), id);
        return response.json({ query });
    } catch (error) {
        if (error instanceof QueryNotFoundError) {
            return response.status(404).json({ error: error.message });
        }
        return response.status(500).json({ error: "Não foi possível buscar a consulta." });
    }
});

export default queryHistoryRoutes;
