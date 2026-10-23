import { Router, type Request, type Response } from "express";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import {
    AuthConfigurationError, AuthUserNotFoundError, PhoneAlreadyRegisteredError,
    InvalidCredentialsError, loginUser, registerUser, ValidationError, getAuthUserById,
    type LoginInput, type RegisterInput
} from "../services/authService.js";

const authRoutes = Router();

function parseRegisterInput(body: unknown): RegisterInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const { name, phone, password, email, timezone } = body as Record<string, unknown>;
    if (typeof name !== "string" || typeof phone !== "string" || typeof password !== "string") return undefined;
    if (email !== undefined && typeof email !== "string") return undefined;
    if (timezone !== undefined && typeof timezone !== "string") return undefined;
    return { name, phone, password, email, timezone };
}

function parseLoginInput(body: unknown): LoginInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const { phone, password } = body as Record<string, unknown>;
    return typeof phone === "string" && typeof password === "string" ? { phone, password } : undefined;
}

function sendAuthError(response: Response, error: unknown): Response | undefined {
    if (error instanceof AuthConfigurationError) return response.status(500).json({ error: "A autenticação não está configurada." });
    if (error instanceof ValidationError) return response.status(400).json({ error: error.message });
    if (error instanceof PhoneAlreadyRegisteredError) return response.status(409).json({ error: error.message });
    if (error instanceof InvalidCredentialsError) return response.status(401).json({ error: "Telefone ou senha inválidos." });
    if (error instanceof AuthUserNotFoundError) return response.status(401).json({ error: "Token de autenticação inválido." });
    return undefined;
}

authRoutes.post("/register", async (request: Request, response: Response) => {
    const input = parseRegisterInput(request.body);
    if (!input) return response.status(400).json({ error: "Informe name, phone e password válidos." });
    try { return response.status(201).json(await registerUser(input)); }
    catch (error) { return sendAuthError(response, error) ?? response.status(500).json({ error: "Não foi possível cadastrar o usuário." }); }
});

authRoutes.post("/login", async (request: Request, response: Response) => {
    const input = parseLoginInput(request.body);
    if (!input) return response.status(400).json({ error: "Informe phone e password válidos." });
    try { return response.json(await loginUser(input)); }
    catch (error) { return sendAuthError(response, error) ?? response.status(500).json({ error: "Não foi possível realizar o login." }); }
});

authRoutes.get("/me", requireAuthentication, async (request: AuthenticatedRequest, response: Response) => {
    try { return response.json({ user: await getAuthUserById(request.auth!.userId) }); }
    catch (error) { return sendAuthError(response, error) ?? response.status(500).json({ error: "Não foi possível buscar o usuário autenticado." }); }
});

export default authRoutes;
