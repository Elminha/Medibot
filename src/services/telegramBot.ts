import { Bot, type Context } from "grammy";
import { consultarBula } from "./bulaService.js";
import { countQueriesSince, saveQuery } from "./queryHistoryService.js";
import { hasExceededHourlyLimit } from "./telegramRateLimiter.js";
import {
    consumeLinkCode,
    getUserIdByChatId,
    TelegramConfigurationError,
    unlinkChat
} from "./telegramLinkService.js";
import { registerUpdateOnce } from "./telegramUpdateLog.js";
import {
    escapeTelegramHtml,
    markdownToTelegramHtml,
    splitTelegramMessage,
    TELEGRAM_SAFETY_NOTICE
} from "./telegramFormatting.js";

const WELCOME_MESSAGE = [
    "Olá! Eu sou o MediBot.",
    "Posso ajudar a entender informações presentes nas bulas de medicamentos disponíveis no sistema.",
    "Sou educativo: não faço diagnóstico, não prescrevo e não substituo a orientação de um profissional de saúde.",
    "",
    "Para usar o bot, vincule sua conta do site: acesse MediBot > Lembretes > Conectar Telegram, gere um código e envie /vincular SEUCODIGO aqui (ou abra o link que o site mostrar)."
].join("\n");

const HELP_MESSAGE = [
    "Comandos disponíveis:",
    "/start <código> — vincula sua conta do MediBot a este chat",
    "/vincular <código> — igual ao /start com código",
    "/desvincular — remove o vínculo deste chat",
    "/ajuda — mostra esta mensagem",
    "",
    "Depois de vinculado, basta enviar sua pergunta sobre um medicamento. Este bot é educativo e não substitui orientação profissional de saúde."
].join("\n");

const NOT_LINKED_MESSAGE =
    "Este chat ainda não está vinculado a uma conta do MediBot. Acesse MediBot > Lembretes > Conectar Telegram, gere um código e envie /vincular SEUCODIGO aqui.";

const RATE_LIMITED_MESSAGE =
    "Você atingiu o limite de perguntas por hora. Tente novamente mais tarde.";

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

async function replyWithHtmlFallback(ctx: Context, html: string): Promise<void> {
    try {
        await ctx.reply(html, { parse_mode: "HTML" });
    } catch (error) {
        console.error("Falha ao enviar mensagem formatada no Telegram; reenviando como texto simples.", error);
        await ctx.reply(stripHtml(html));
    }
}

async function sendBulaAnswer(ctx: Context, answer: string): Promise<void> {
    const html = `${markdownToTelegramHtml(answer)}\n\n<i>${escapeTelegramHtml(TELEGRAM_SAFETY_NOTICE)}</i>`;
    const parts = splitTelegramMessage(html);

    for (const part of parts) {
        await replyWithHtmlFallback(ctx, part);
    }
}

async function handleLinkAttempt(ctx: Context, rawCode: string | undefined): Promise<void> {
    const code = rawCode?.trim();
    if (!code) {
        await ctx.reply("Informe o código gerado no site. Uso: /vincular SEUCODIGO");
        return;
    }

    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
        return;
    }

    const outcome = await consumeLinkCode(code, chatId);

    switch (outcome.status) {
        case "linked":
            await ctx.reply("Conta vinculada com sucesso. Agora você pode enviar perguntas sobre bulas por aqui.");
            return;
        case "chat-already-linked":
            await ctx.reply("Este chat já está vinculado a uma conta. Envie /desvincular aqui antes de vincular outra conta.");
            return;
        case "user-already-linked":
            await ctx.reply("Essa conta já está vinculada a outro chat do Telegram. Desvincule-a no site ou no chat atualmente vinculado antes de tentar novamente.");
            return;
        case "invalid":
        default:
            await ctx.reply("Código inválido ou expirado. Gere um novo código no site e tente novamente.");
    }
}

function registerHandlers(bot: Bot): void {
    bot.use(async (ctx, next) => {
        const chatId = ctx.chat?.id;
        const updateId = ctx.update.update_id;

        if (chatId === undefined) {
            await next();
            return;
        }

        const isFirstTime = await registerUpdateOnce(updateId, chatId);
        if (!isFirstTime) {
            return;
        }

        await next();
    });

    bot.command("start", async (ctx) => {
        const code = ctx.match?.trim();
        if (!code) {
            await ctx.reply(WELCOME_MESSAGE);
            return;
        }
        await handleLinkAttempt(ctx, code);
    });

    bot.command("vincular", async (ctx) => {
        await handleLinkAttempt(ctx, ctx.match);
    });

    bot.command("desvincular", async (ctx) => {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
            return;
        }
        const wasLinked = await unlinkChat(chatId);
        await ctx.reply(wasLinked
            ? "Vínculo removido. Este chat não está mais conectado a nenhuma conta do MediBot."
            : "Este chat não estava vinculado a nenhuma conta.");
    });

    bot.command("ajuda", async (ctx) => {
        await ctx.reply(HELP_MESSAGE);
    });

    bot.on("message:text", async (ctx) => {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
            return;
        }

        const userId = await getUserIdByChatId(chatId);
        if (!userId) {
            await ctx.reply(NOT_LINKED_MESSAGE);
            return;
        }

        const question = ctx.message.text.trim();
        if (!question) {
            return;
        }

        const oneHourAgo = new Date(Date.now() - 60 * 60_000);
        const recentQuestionCount = await countQueriesSince(userId, oneHourAgo);
        if (hasExceededHourlyLimit(recentQuestionCount)) {
            await ctx.reply(RATE_LIMITED_MESSAGE);
            return;
        }

        await ctx.replyWithChatAction("typing").catch(() => undefined);

        let resultado;
        try {
            resultado = await consultarBula(question);
        } catch (error) {
            console.error("Falha ao consultar a bula via Telegram.", error);
            await ctx.reply("Não foi possível consultar a bula agora. Tente novamente em alguns instantes.");
            return;
        }

        try {
            await saveQuery(userId, question, resultado.answer, resultado.sources);
        } catch (error) {
            console.error("Não foi possível salvar o histórico da consulta vinda do Telegram.", error);
        }

        await sendBulaAnswer(ctx, resultado.answer);
    });

    bot.catch((error) => {
        console.error("Erro não tratado no bot do Telegram.", error.error);
    });
}

let botInstance: Bot | undefined;

/** Cria o bot sob demanda: a ausência de TELEGRAM_BOT_TOKEN não afeta o restante da aplicação. */
export function getTelegramBot(): Bot {
    if (!botInstance) {
        const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
        if (!token) {
            throw new TelegramConfigurationError("TELEGRAM_BOT_TOKEN não foi configurado.");
        }
        botInstance = new Bot(token);
        registerHandlers(botInstance);
    }
    return botInstance;
}
