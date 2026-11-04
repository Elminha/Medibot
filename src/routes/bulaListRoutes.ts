import { Router, type Response } from "express";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { listAvailableBulas } from "../services/bulaListService.js";

const bulaListRoutes = Router();

bulaListRoutes.use(requireAuthentication);

bulaListRoutes.get("/", async (_request: AuthenticatedRequest, response: Response) => {
    try {
        const bulas = await listAvailableBulas();
        return response.json({ bulas, count: bulas.length });
    } catch (error) {
        console.error("Não foi possível carregar a lista de bulas disponíveis.", error);
        return response.status(500).json({
            error: "Não foi possível carregar a lista de bulas disponíveis no momento."
        });
    }
});

export default bulaListRoutes;
