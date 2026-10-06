import type { NextFunction, Request, Response } from "express";
import { AuthConfigurationError, getAuthenticatedUserId } from "../services/authService.js";

export interface AuthenticatedRequest extends Request {
    auth?: {
        userId: number;
    };
}

export function requireAuthentication(
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction
): void {
    const authorization = request.header("authorization");
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    let userId: number | undefined;
    try {
        userId = token ? getAuthenticatedUserId(token) : undefined;
    } catch (error) {
        if (error instanceof AuthConfigurationError) {
            response.status(500).json({ error: "A autenticação não está configurada." });
            return;
        }
        response.status(500).json({ error: "Não foi possível validar a autenticação." });
        return;
    }

    if (!userId) {
        response.status(401).json({ error: "Token de autenticação ausente ou inválido." });
        return;
    }

    request.auth = { userId };
    next();
}
