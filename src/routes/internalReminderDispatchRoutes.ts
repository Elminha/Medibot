import { Router, type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { getDatabasePool } from "../database/database.js";
import { getTelegramBot } from "../services/telegramBot.js";
import { runReminderDispatch, type TelegramSender } from "../services/reminderDispatchService.js";

const internalReminderDispatchRoutes = Router();

const MIN_CRON_SECRET_LENGTH = 24;

/**
 * undefined quando CRON_SECRET não está configurado OU é curto demais: a rota deve
 * responder 404 e NUNCA executar (não revela nem que a rota existe).
 */
function getConfiguredCronSecret(): string | undefined {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) {
        return undefined;
    }
    return secret;
}

/**
 * Comparação em tempo constante que nunca lança nem vaza o tamanho relativo dos dois
 * valores: compara o hash SHA-256 de cada um (sempre 32 bytes), não os valores brutos
 * (que podem ter tamanhos diferentes — timingSafeEqual lançaria nesse caso).
 */
function secretsMatch(provided: string, expected: string): boolean {
    const providedHash = createHash("sha256").update(provided).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    return timingSafeEqual(providedHash, expectedHash);
}

function extractProvidedSecret(request: Request): string | undefined {
    const headerSecret = request.header("x-cron-secret")?.trim();
    if (headerSecret) {
        return headerSecret;
    }

    const authorization = request.header("authorization")?.trim();
    const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
    return bearerMatch?.[1]?.trim();
}

function buildTelegramSender(): TelegramSender {
    const bot = getTelegramBot();
    return {
        async sendMessage(chatId, text) {
            await bot.api.sendMessage(chatId, text);
        }
    };
}

internalReminderDispatchRoutes.post("/dispatch", async (request: Request, response: Response) => {
    const configuredSecret = getConfiguredCronSecret();
    if (!configuredSecret) {
        response.status(404).end();
        return;
    }

    const providedSecret = extractProvidedSecret(request);
    if (!providedSecret || !secretsMatch(providedSecret, configuredSecret)) {
        response.status(401).json({ error: "Não autorizado." });
        return;
    }

    const dryRun = request.query.dryRun === "1";

    try {
        const sender: TelegramSender = dryRun
            ? { sendMessage: async () => { throw new Error("dryRun não deve enviar mensagens."); } }
            : buildTelegramSender();

        const summary = await runReminderDispatch(
            { pool: getDatabasePool(), sender, now: () => new Date() },
            { dryRun }
        );

        // NUNCA incluir chat_id, nome de medicamento, e-mail ou qualquer outro dado
        // pessoal na resposta: só contagens.
        response.status(200).json({ dryRun, ...summary });
    } catch (error) {
        // Nunca logar o segredo, token ou chat_id aqui — só o erro técnico da lib.
        console.error("Falha ao executar o despacho de lembretes por Telegram.", error);
        response.status(500).json({ error: "Falha ao despachar lembretes." });
    }
});

export default internalReminderDispatchRoutes;
