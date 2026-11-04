import { Router, type Request, type Response } from "express";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import {
    AccountAlreadyExistsError,
    AuthConfigurationError,
    InvalidCredentialsError,
    loginUser,
    registerUser,
    TooManyRegistrationAttemptsError,
    ValidationError,
    type LoginInput,
    type RegisterInput
} from "../services/authService.js";
import { confirmPasswordReset, isPasswordResetEnabled, requestPasswordReset } from "../services/passwordResetService.js";
import {
    confirmEmailVerification,
    isEmailVerificationRequired,
    issueAndSendVerificationToken,
    resendVerificationEmail
} from "../services/emailVerificationService.js";

const authRoutes = Router();

function parseForgotPasswordInput(body: unknown): string | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }
    const { email } = body as Record<string, unknown>;
    return typeof email === "string" && email.trim() ? email : undefined;
}

function parseResetPasswordInput(body: unknown): { token: string; password: string } | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }
    const { token, password } = body as Record<string, unknown>;
    return typeof token === "string" && token.trim() && typeof password === "string"
        ? { token, password }
        : undefined;
}

function parseVerifyEmailInput(body: unknown): string | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }
    const { token } = body as Record<string, unknown>;
    return typeof token === "string" && token.trim() ? token : undefined;
}

function parseRegisterInput(body: unknown): RegisterInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }

    const { name, email, password, phone, timezone, termsAccepted } = body as Record<string, unknown>;
    if (typeof name !== "string" || typeof password !== "string") {
        return undefined;
    }
    if (email !== undefined && typeof email !== "string") {
        return undefined;
    }
    if (phone !== undefined && typeof phone !== "string") {
        return undefined;
    }
    if (timezone !== undefined && typeof timezone !== "string") {
        return undefined;
    }
    if (termsAccepted !== undefined && typeof termsAccepted !== "boolean") {
        return undefined;
    }

    return { name, email, password, phone, timezone, termsAccepted };
}

function parseLoginInput(body: unknown): LoginInput | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }

    const { identifier, password } = body as Record<string, unknown>;
    return typeof identifier === "string" && typeof password === "string" ? { identifier, password } : undefined;
}

function sendAuthError(response: Response, error: unknown): Response | undefined {
    if (error instanceof AuthConfigurationError) {
        return response.status(500).json({ error: "A autenticação não está configurada." });
    }
    if (error instanceof ValidationError) {
        return response.status(400).json({ error: error.message });
    }
    if (error instanceof AccountAlreadyExistsError) {
        return response.status(409).json({ error: error.message });
    }
    if (error instanceof TooManyRegistrationAttemptsError) {
        return response.status(429).json({ error: error.message });
    }
    if (error instanceof InvalidCredentialsError) {
        return response.status(401).json({ error: error.message });
    }
    return undefined;
}

authRoutes.post("/register", async (request: Request, response: Response) => {
    const input = parseRegisterInput(request.body);
    if (!input) {
        return response.status(400).json({ error: "Informe nome, e-mail e senha válidos." });
    }

    try {
        const result = await registerUser(input);

        // Best-effort: a conta já foi criada (sem verificar) mesmo que o envio falhe
        // (ex.: SMTP não configurado). O usuário pode pedir reenvio depois.
        if (isEmailVerificationRequired() && result.user.email) {
            try {
                await issueAndSendVerificationToken(result.user.id, result.user.email);
            } catch (error) {
                console.error(
                    "Não foi possível enviar o e-mail de verificação no cadastro.",
                    error instanceof Error ? error.message : error
                );
            }
        }

        return response.status(201).json(result);
    } catch (error) {
        return sendAuthError(response, error)
            ?? response.status(500).json({ error: "Não foi possível cadastrar o usuário." });
    }
});

authRoutes.post("/login", async (request: Request, response: Response) => {
    const input = parseLoginInput(request.body);
    if (!input) {
        return response.status(400).json({ error: "Informe um e-mail ou telefone e uma senha válidos." });
    }

    try {
        const result = await loginUser(input);
        return response.json(result);
    } catch (error) {
        return sendAuthError(response, error)
            ?? response.status(500).json({ error: "Não foi possível realizar o login." });
    }
});

authRoutes.get("/me", requireAuthentication, (request: AuthenticatedRequest, response: Response) => {
    return response.json({ user: request.auth!.user });
});

authRoutes.get("/capabilities", (_request: Request, response: Response) => {
    return response.json({
        passwordReset: isPasswordResetEnabled(),
        emailVerificationRequired: isEmailVerificationRequired()
    });
});

authRoutes.post("/forgot-password", async (request: Request, response: Response) => {
    if (!isPasswordResetEnabled()) {
        return response.status(404).json({ error: "Recurso indisponível." });
    }

    const email = parseForgotPasswordInput(request.body);
    if (!email) {
        return response.status(400).json({ error: "Informe um e-mail válido." });
    }

    try {
        const outcome = await requestPasswordReset(email, request.ip ?? "");
        return response.status(outcome.status === "rate-limited" ? 429 : 200).json({ message: outcome.message });
    } catch (error) {
        if (error instanceof ValidationError) {
            return response.status(400).json({ error: error.message });
        }
        console.error("Falha inesperada ao pedir redefinição de senha.", error instanceof Error ? error.message : error);
        return response.status(500).json({ error: "Não foi possível processar o pedido." });
    }
});

authRoutes.post("/reset-password", async (request: Request, response: Response) => {
    if (!isPasswordResetEnabled()) {
        return response.status(404).json({ error: "Recurso indisponível." });
    }

    const input = parseResetPasswordInput(request.body);
    if (!input) {
        return response.status(400).json({ error: "Informe o token e a nova senha." });
    }

    try {
        const outcome = await confirmPasswordReset(input.token, input.password, request.ip ?? "");
        if (outcome === "rate-limited") {
            return response.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
        }
        if (outcome === "invalid") {
            return response.status(400).json({ error: "Link inválido ou expirado." });
        }
        return response.status(200).json({ message: "Senha redefinida com sucesso. Faça login com sua nova senha." });
    } catch (error) {
        if (error instanceof ValidationError) {
            return response.status(400).json({ error: error.message });
        }
        console.error("Falha inesperada ao redefinir senha.", error instanceof Error ? error.message : error);
        return response.status(500).json({ error: "Não foi possível redefinir a senha." });
    }
});

authRoutes.post("/verify-email", async (request: Request, response: Response) => {
    const token = parseVerifyEmailInput(request.body);
    if (!token) {
        return response.status(400).json({ error: "Informe o token de verificação." });
    }

    try {
        const outcome = await confirmEmailVerification(token);
        if (outcome === "invalid") {
            return response.status(400).json({ error: "Link inválido ou expirado." });
        }
        return response.status(200).json({ message: "E-mail confirmado com sucesso." });
    } catch (error) {
        console.error("Falha inesperada ao confirmar e-mail.", error instanceof Error ? error.message : error);
        return response.status(500).json({ error: "Não foi possível confirmar o e-mail." });
    }
});

// Autenticada (precisa saber de quem é o e-mail), mas sem requireVerifiedEmail: é
// exatamente a rota que um usuário não verificado precisa conseguir chamar.
authRoutes.post(
    "/resend-verification",
    requireAuthentication,
    async (request: AuthenticatedRequest, response: Response) => {
        try {
            const outcome = await resendVerificationEmail(request.auth!.userId);

            switch (outcome) {
                case "ok":
                    return response.status(200).json({ message: "E-mail de verificação reenviado." });
                case "already-verified":
                    return response.status(200).json({ message: "Seu e-mail já está confirmado." });
                case "no-email":
                    return response.status(400).json({ error: "Esta conta não tem e-mail cadastrado." });
                case "rate-limited":
                    return response.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
            }
        } catch (error) {
            console.error("Falha inesperada ao reenviar e-mail de verificação.", error instanceof Error ? error.message : error);
            return response.status(500).json({ error: "Não foi possível reenviar o e-mail de verificação." });
        }
    }
);

export default authRoutes;
