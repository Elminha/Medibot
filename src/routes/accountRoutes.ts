import { Router, type Response } from "express";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { AccountDeletionRateLimitedError, deleteOwnAccount, IncorrectPasswordError } from "../services/accountService.js";

const accountRoutes = Router();

// Sem requireVerifiedEmail de propósito: uma conta ainda não verificada também
// precisa conseguir se excluir (direito de exclusão não pode depender de confirmar o e-mail primeiro).
accountRoutes.use(requireAuthentication);

function parseDeleteAccountInput(body: unknown): string | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }
    const { password } = body as Record<string, unknown>;
    return typeof password === "string" && password ? password : undefined;
}

accountRoutes.delete("/", async (request: AuthenticatedRequest, response: Response) => {
    const password = parseDeleteAccountInput(request.body);
    if (!password) {
        return response.status(400).json({ error: "Informe sua senha para confirmar a exclusão." });
    }

    try {
        await deleteOwnAccount(request.auth!.userId, password);
        return response.status(204).send();
    } catch (error) {
        if (error instanceof IncorrectPasswordError) {
            return response.status(401).json({ error: error.message });
        }
        if (error instanceof AccountDeletionRateLimitedError) {
            return response.status(429).json({ error: error.message });
        }
        console.error("Falha inesperada ao excluir conta.", error instanceof Error ? error.message : error);
        return response.status(500).json({ error: "Não foi possível excluir a conta." });
    }
});

export default accountRoutes;
