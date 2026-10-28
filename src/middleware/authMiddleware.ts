import type { NextFunction, Request, Response } from "express";
import { AuthConfigurationError, getAuthenticatedUser, type AuthUser } from "../services/authService.js";

export interface AuthenticatedRequest extends Request {
    auth?: {
        userId: number;
        user: AuthUser;
    };
}

/**
 * Busca o usuário autenticado (uma única consulta ao banco, que também verifica se o
 * token foi emitido antes de uma troca de senha). Rotas que precisam do usuário
 * completo (ex.: /me) reaproveitam `request.auth.user` em vez de consultar de novo.
 */
export async function requireAuthentication(
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction
): Promise<void> {
    const authorization = request.header("authorization");
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!token) {
        response.status(401).json({ error: "Token de autenticação ausente ou inválido." });
        return;
    }

    let user: AuthUser | undefined;
    try {
        user = await getAuthenticatedUser(token);
    } catch (error) {
        if (error instanceof AuthConfigurationError) {
            response.status(500).json({ error: "A autenticação não está configurada." });
            return;
        }
        response.status(500).json({ error: "Não foi possível validar a autenticação." });
        return;
    }

    if (!user) {
        response.status(401).json({ error: "Token de autenticação ausente ou inválido." });
        return;
    }

    request.auth = { userId: user.id, user };
    next();
}
