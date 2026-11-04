import type { NextFunction, Request, Response } from "express";
import { AuthConfigurationError, getAuthenticatedUser, type AuthUser } from "../services/authService.js";
import { isEmailVerificationRequired } from "../services/emailVerificationService.js";

export const EMAIL_NOT_VERIFIED_CODE = "EMAIL_NOT_VERIFIED";

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
    // Dados de um usuário autenticado (lembretes, medicamentos, histórico) nunca devem
    // ficar no cache HTTP do navegador: um 304 aqui não significa "nada mudou", pode só
    // significar que o navegador não revalidou o corpo da resposta.
    response.set("Cache-Control", "no-store");

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

/**
 * Roda depois de requireAuthentication: bloqueia rotas protegidas enquanto o
 * e-mail não for confirmado. Não se aplica a /me, /capabilities, /verify-email e
 * /resend-verification, que ficam fora desse middleware de propósito (ver
 * authRoutes.ts e os routers que usam requireVerifiedEmail).
 */
export function requireVerifiedEmail(
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction
): void {
    if (!isEmailVerificationRequired() || request.auth!.user.emailVerified) {
        next();
        return;
    }

    response.status(403).json({
        error: "Confirme seu e-mail para continuar.",
        code: EMAIL_NOT_VERIFIED_CODE
    });
}
