import { Router, type Request, type Response } from "express";
import { webhookCallback } from "grammy";
import { requireAuthentication, type AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { getTelegramBot } from "../services/telegramBot.js";
import {
    buildTelegramDeepLink,
    createLinkCode,
    TelegramConfigurationError,
    unlinkUser
} from "../services/telegramLinkService.js";

const telegramRoutes = Router();

const DEFAULT_WEBHOOK_TIMEOUT_MS = 45_000;

export function getWebhookTimeoutMs(): number {
    const configured = Number(process.env.TELEGRAM_WEBHOOK_TIMEOUT_MS);
    return configured > 0 ? configured : DEFAULT_WEBHOOK_TIMEOUT_MS;
}

function isValidWebhookRequest(request: Request): boolean {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    const providedSecret = request.header("x-telegram-bot-api-secret-token");
    return Boolean(expectedSecret) && providedSecret === expectedSecret;
}

type ExpressWebhookHandler = (request: Request, response: Response) => Promise<void>;

// Criado uma única vez (não a cada request): webhookCallback chama bot.init() só na
// primeira invocação do callback retornado; recriá-lo por request forçaria um getMe()
// a cada mensagem, consumindo parte do orçamento de tempo do timeout abaixo.
let handleUpdate: ExpressWebhookHandler | undefined;

function getWebhookHandler(): ExpressWebhookHandler {
    if (!handleUpdate) {
        handleUpdate = webhookCallback(getTelegramBot(), "express", {
            onTimeout: "throw",
            timeoutMilliseconds: getWebhookTimeoutMs()
        }) as ExpressWebhookHandler;
    }
    return handleUpdate;
}

telegramRoutes.post("/webhook", async (request: Request, response: Response) => {
    if (!isValidWebhookRequest(request)) {
        response.status(401).end();
        return;
    }

    try {
        await getWebhookHandler()(request, response);
    } catch (error) {
        console.error("Falha ao processar atualização do Telegram.", error);
        if (!response.headersSent) {
            // Responde 200 mesmo em erro interno já tratado, para evitar reenvio em loop pelo Telegram.
            response.status(200).end();
        }
    }
});

telegramRoutes.post("/link-code", requireAuthentication, async (request: AuthenticatedRequest, response: Response) => {
    try {
        const { code, expiresAt } = await createLinkCode(request.auth!.userId);
        response.status(201).json({
            code,
            expiresAt: expiresAt.toISOString(),
            telegramLink: buildTelegramDeepLink(code)
        });
    } catch (error) {
        if (error instanceof TelegramConfigurationError) {
            response.status(500).json({ error: "A integração com o Telegram não está configurada." });
            return;
        }
        console.error("Não foi possível gerar o código de vínculo do Telegram.", error);
        response.status(500).json({ error: "Não foi possível gerar o código de vínculo." });
    }
});

telegramRoutes.delete("/link", requireAuthentication, async (request: AuthenticatedRequest, response: Response) => {
    try {
        await unlinkUser(request.auth!.userId);
        response.status(204).send();
    } catch (error) {
        console.error("Não foi possível desvincular o Telegram.", error);
        response.status(500).json({ error: "Não foi possível desvincular o Telegram." });
    }
});

export default telegramRoutes;
