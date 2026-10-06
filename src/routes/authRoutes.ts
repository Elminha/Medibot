import { Router, type Request, type Response } from "express";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import {
    AuthConfigurationError,
    AuthUserNotFoundError,
    EmailAlreadyRegisteredError,
    InvalidCredentialsError,
    loginUser,
    registerUser,
    ValidationError,
    getAuthUserById,
    type LoginInput,
    type RegisterInput
} from "../services/authService.js";

const authRoutes = Router();

function parseRegisterInput(body: unknown): RegisterInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }

    const { name, email, password, phone, timezone } = body as Record<string, unknown>;
    if (typeof name !== "string" || typeof email !== "string" || typeof password !== "string") {
        return undefined;
    }
    if (phone !== undefined && typeof phone !== "string") {
        return undefined;
    }
    if (timezone !== undefined && typeof timezone !== "string") {
        return undefined;
    }

    return { name, email, password, phone, timezone };
}

function parseLoginInput(body: unknown): LoginInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }

    const { email, password } = body as Record<string, unknown>;
    return typeof email === "string" && typeof password === "string" ? { email, password } : undefined;
}

function sendAuthError(response: Response, error: unknown): Response | undefined {
    if (error instanceof AuthConfigurationError) {
        return response.status(500).json({ error: "A autenticação não está configurada." });
    }
    if (error instanceof ValidationError) {
        return response.status(400).json({ error: error.message });
    }
    if (error instanceof EmailAlreadyRegisteredError) {
        return response.status(409).json({ error: error.message });
    }
    if (error instanceof InvalidCredentialsError) {
        return response.status(401).json({ error: "E-mail ou senha inválidos." });
    }
    if (error instanceof AuthUserNotFoundError) {
        return response.status(401).json({ error: "Token de autenticação inválido." });
    }
    return undefined;
}

authRoutes.post("/register", async (request: Request, response: Response) => {
    const input = parseRegisterInput(request.body);
    if (!input) {
        return response.status(400).json({ error: "Informe name, email e password válidos." });
    }

    try {
        const result = await registerUser(input);
        return response.status(201).json(result);
    } catch (error) {
        return sendAuthError(response, error)
            ?? response.status(500).json({ error: "Não foi possível cadastrar o usuário." });
    }
});

authRoutes.post("/login", async (request: Request, response: Response) => {
    const input = parseLoginInput(request.body);
    if (!input) {
        return response.status(400).json({ error: "Informe email e password válidos." });
    }

    try {
        const result = await loginUser(input);
        return response.json(result);
    } catch (error) {
        return sendAuthError(response, error)
            ?? response.status(500).json({ error: "Não foi possível realizar o login." });
    }
});

authRoutes.get("/me", requireAuthentication, async (request: AuthenticatedRequest, response: Response) => {
    try {
        const user = await getAuthUserById(request.auth!.userId);
        return response.json({ user });
    } catch (error) {
        return sendAuthError(response, error)
            ?? response.status(500).json({ error: "Não foi possível buscar o usuário autenticado." });
    }
});

export default authRoutes;
