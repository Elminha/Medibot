import { Bot, InlineKeyboard, type Context } from "grammy";
import { consultarBula } from "./bulaService.js";
import {
    countQueries,
    countQueriesSince,
    countTelegramQueries,
    deleteTelegramQueries,
    getQueryById,
    getRecentConversationTurns,
    listQueries,
    QueryNotFoundError,
    saveQuery,
    type QueryHistoryEntry
} from "./queryHistoryService.js";
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
import {
    buildHistoryOpenCallbackData,
    buildHistoryPageCallbackData,
    type HistoryCallbackAction,
    buildDeleteConfirmCallbackData,
    currentMinutesSinceEpoch,
    DELETE_CANCEL_CALLBACK_DATA,
    isDeleteConfirmationExpired,
    parseDeleteConfirmCallbackData,
    parseHistoryCallbackData
} from "./telegramHistoryCallback.js";
import {
    formatHistoryButtonLabel,
    formatHistoryListMessage,
    HISTORY_PAGE_SIZE,
    paginateHistory,
    resolveHistoryDetailHtml
} from "./telegramHistoryFormatting.js";

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
    "/historico — mostra suas consultas recentes (site e Telegram)",
    "/apagar — apaga as consultas feitas por aqui pelo Telegram",
    "/ajuda — mostra esta mensagem",
    "",
    "Depois de vinculado, basta enviar sua pergunta sobre um medicamento. Este bot é educativo e não substitui orientação profissional de saúde."
].join("\n");

const NOT_LINKED_MESSAGE =
    "Este chat ainda não está vinculado a uma conta do MediBot. Acesse MediBot > Lembretes > Conectar Telegram, gere um código e envie /vincular SEUCODIGO aqui.";

const RATE_LIMITED_MESSAGE =
    "Você atingiu o limite de perguntas por hora. Tente novamente mais tarde.";

const GROUP_CHAT_HISTORY_MESSAGE = "Por privacidade, use /historico em uma conversa privada comigo.";
const GROUP_CHAT_DELETE_MESSAGE = "Por privacidade, use /apagar em uma conversa privada comigo.";
const UNKNOWN_ACTION_MESSAGE = "Ação desconhecida ou expirada.";
const UNKNOWN_COMMAND_MESSAGE = "Não conheci esse comando. Use /ajuda para ver os comandos disponíveis.";

/**
 * Monta a confirmação de vínculo, acrescentando o aviso sobre consultas
 * anteriores quando a conta já tinha alguma (em qualquer canal).
 */
export function buildLinkSuccessMessage(existingQueryCount: number): string {
    const base = "Conta vinculada com sucesso. Agora você pode enviar perguntas sobre bulas por aqui.";
    if (existingQueryCount <= 0) {
        return base;
    }
    const noun = existingQueryCount === 1 ? "consulta anterior" : "consultas anteriores";
    return `${base} Você tem ${existingQueryCount} ${noun}. Use /historico para ver.`;
}

/**
 * Defesa em profundidade: mesmo com a ordem de registro correta, o handler de
 * texto livre nunca deve tratar uma mensagem que seja um comando (atual ou
 * futuro) como pergunta. Verifica tanto o prefixo "/" quanto a entity
 * `bot_command` que o Telegram anexa no início da mensagem.
 */
function isCommandMessage(ctx: Context): boolean {
    const text = ctx.message?.text;
    if (!text) {
        return false;
    }
    if (text.startsWith("/")) {
        return true;
    }
    const entities = ctx.message?.entities ?? [];
    return entities.some((entity) => entity.type === "bot_command" && entity.offset === 0);
}

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

async function replyWithHtmlFallback(
    ctx: Context,
    html: string,
    extra?: { reply_markup?: InlineKeyboard }
): Promise<void> {
    try {
        await ctx.reply(html, { parse_mode: "HTML", ...extra });
    } catch (error) {
        console.error("Falha ao enviar mensagem formatada no Telegram; reenviando como texto simples.", error);
        await ctx.reply(stripHtml(html), extra);
    }
}

async function sendBulaAnswer(
    ctx: Context,
    resultado: { answer: string; sources: string[]; usedFileSearch: boolean }
): Promise<void> {
    let html = markdownToTelegramHtml(resultado.answer);

    if (resultado.sources.length > 0) {
        html += `\n\n<i>Fontes: ${escapeTelegramHtml(resultado.sources.join(", "))}</i>`;
    }

    if (resultado.usedFileSearch) {
        html += `\n\n<i>${escapeTelegramHtml(TELEGRAM_SAFETY_NOTICE)}</i>`;
    }

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
        case "linked": {
            let existingQueryCount = 0;
            try {
                existingQueryCount = await countQueries(outcome.userId);
            } catch (error) {
                console.error("Não foi possível contar consultas existentes após vincular conta do Telegram.", error);
            }
            await ctx.reply(buildLinkSuccessMessage(existingQueryCount));
            return;
        }
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

function buildHistoryKeyboard(page: ReturnType<typeof paginateHistory>): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    page.items.forEach((entry, index) => {
        keyboard.text(formatHistoryButtonLabel(entry, index), buildHistoryOpenCallbackData(entry.id, page.offset));
        keyboard.row();
    });

    if (page.hasPrevious) {
        keyboard.text("⬅ Anterior", buildHistoryPageCallbackData(Math.max(0, page.offset - HISTORY_PAGE_SIZE)));
    }
    if (page.hasNext) {
        keyboard.text("Ver mais ➡", buildHistoryPageCallbackData(page.offset + HISTORY_PAGE_SIZE));
    }

    return keyboard;
}

async function sendHistoryPage(ctx: Context, userId: number, offset: number): Promise<void> {
    const entries = await listQueries(userId);
    const page = paginateHistory(entries, offset);
    const text = formatHistoryListMessage(page);
    const keyboard = page.items.length > 0 ? buildHistoryKeyboard(page) : undefined;
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
}

async function handleHistoryCallback(ctx: Context, chatId: number, action: HistoryCallbackAction): Promise<void> {
    const userId = await getUserIdByChatId(chatId);
    if (!userId) {
        await ctx.answerCallbackQuery({ text: NOT_LINKED_MESSAGE, show_alert: true });
        return;
    }

    if (action.type === "page") {
        await ctx.answerCallbackQuery();
        await sendHistoryPage(ctx, userId, action.offset);
        return;
    }

    // SEGURANÇA: getQueryById filtra por WHERE id = $1 AND user_id = $2, então uma
    // consulta inexistente ou de outra conta cai no mesmo catch, sem distinção.
    let entry: QueryHistoryEntry | null = null;
    try {
        entry = await getQueryById(userId, action.id);
    } catch (error) {
        if (!(error instanceof QueryNotFoundError)) {
            console.error("Falha ao buscar consulta do histórico via Telegram.", error);
        }
        entry = null;
    }

    await ctx.answerCallbackQuery();

    const html = resolveHistoryDetailHtml(entry);
    if (!entry) {
        await ctx.reply(html);
        return;
    }

    const keyboard = new InlineKeyboard().text("↩ Voltar à lista", buildHistoryPageCallbackData(action.offset));
    const parts = splitTelegramMessage(html);
    for (let index = 0; index < parts.length; index += 1) {
        const isLast = index === parts.length - 1;
        await replyWithHtmlFallback(ctx, parts[index], isLast ? { reply_markup: keyboard } : undefined);
    }
}

async function handleDeleteConfirmCallback(ctx: Context, chatId: number, minutesSinceEpoch: number): Promise<void> {
    if (isDeleteConfirmationExpired(minutesSinceEpoch)) {
        await ctx.answerCallbackQuery({ text: "Essa confirmação expirou. Envie /apagar de novo.", show_alert: true });
        return;
    }

    const userId = await getUserIdByChatId(chatId);
    if (!userId) {
        await ctx.answerCallbackQuery({ text: NOT_LINKED_MESSAGE, show_alert: true });
        return;
    }

    const deletedCount = await deleteTelegramQueries(userId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
        deletedCount > 0
            ? `${deletedCount} consulta${deletedCount === 1 ? "" : "s"} feita${deletedCount === 1 ? "" : "s"} pelo Telegram ${deletedCount === 1 ? "foi apagada" : "foram apagadas"}. As mensagens já enviadas neste chat não são apagadas por mim — você pode limpar a conversa pelo próprio Telegram, se quiser. As consultas feitas pelo site continuam no histórico do site, onde podem ser apagadas uma a uma.`
            : "Não havia mais consultas do Telegram para apagar."
    ).catch(() => undefined);
}

/** Exportado para o teste de roteamento (tests/telegramBotRouting.test.ts), que monta um bot real. */
export function registerHandlers(bot: Bot): void {
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

    // IMPORTANTE: todo `bot.command(...)` precisa ser registrado ANTES do
    // `bot.on("message:text", ...)` abaixo. grammY roda os middlewares na ordem
    // de registro e cada um encerra a cadeia se seu filtro bater (sem chamar
    // `next()`); "message:text" casa com QUALQUER mensagem de texto, incluindo
    // comandos, então um comando registrado depois dele nunca seria alcançado.
    bot.command("historico", async (ctx) => {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
            return;
        }
        if (ctx.chat?.type !== "private") {
            await ctx.reply(GROUP_CHAT_HISTORY_MESSAGE);
            return;
        }

        const userId = await getUserIdByChatId(chatId);
        if (!userId) {
            await ctx.reply(NOT_LINKED_MESSAGE);
            return;
        }

        await sendHistoryPage(ctx, userId, 0);
    });

    bot.command("apagar", async (ctx) => {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
            return;
        }
        if (ctx.chat?.type !== "private") {
            await ctx.reply(GROUP_CHAT_DELETE_MESSAGE);
            return;
        }

        const userId = await getUserIdByChatId(chatId);
        if (!userId) {
            await ctx.reply(NOT_LINKED_MESSAGE);
            return;
        }

        const count = await countTelegramQueries(userId);
        if (count === 0) {
            await ctx.reply("Não há consultas feitas pelo Telegram para apagar.");
            return;
        }

        const keyboard = new InlineKeyboard()
            .text("Sim, apagar", buildDeleteConfirmCallbackData(currentMinutesSinceEpoch()))
            .text("Cancelar", DELETE_CANCEL_CALLBACK_DATA);

        await ctx.reply(
            `Isso vai apagar ${count} consulta${count === 1 ? "" : "s"} feita${count === 1 ? "" : "s"} por aqui pelo Telegram. As consultas feitas pelo site não serão afetadas e continuam no histórico do site, onde podem ser apagadas uma a uma. Confirma?`,
            { reply_markup: keyboard }
        );
    });

    bot.on("message:text", async (ctx) => {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
            return;
        }

        // Defesa em profundidade: nenhum comando (conhecido ou não) vira pergunta,
        // chama a OpenAI, é salvo em queries ou conta no limite por hora.
        if (isCommandMessage(ctx)) {
            await ctx.reply(UNKNOWN_COMMAND_MESSAGE);
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

        let history: Awaited<ReturnType<typeof getRecentConversationTurns>> = [];
        try {
            history = await getRecentConversationTurns(userId);
        } catch (error) {
            console.error("Não foi possível carregar o contexto da conversa via Telegram.", error);
        }

        let resultado;
        try {
            resultado = await consultarBula(question, { history });
        } catch (error) {
            console.error("Falha ao consultar a bula via Telegram.", error);
            await ctx.reply("Não foi possível consultar a bula agora. Tente novamente em alguns instantes.");
            return;
        }

        try {
            await saveQuery(userId, question, resultado.answer, resultado.sources, "telegram");
        } catch (error) {
            console.error("Não foi possível salvar o histórico da consulta vinda do Telegram.", error);
        }

        await sendBulaAnswer(ctx, resultado);
    });

    bot.on("callback_query:data", async (ctx) => {
        const data = ctx.callbackQuery.data;
        const chatId = ctx.chat?.id;

        if (chatId === undefined) {
            await ctx.answerCallbackQuery();
            return;
        }

        if (data === DELETE_CANCEL_CALLBACK_DATA) {
            await ctx.answerCallbackQuery({ text: "Operação cancelada." });
            await ctx.editMessageText("Apagar consultas do Telegram: cancelado.").catch(() => undefined);
            return;
        }

        const deleteConfirm = parseDeleteConfirmCallbackData(data);
        if (deleteConfirm) {
            await handleDeleteConfirmCallback(ctx, chatId, deleteConfirm.minutesSinceEpoch);
            return;
        }

        const historyAction = parseHistoryCallbackData(data);
        if (historyAction) {
            await handleHistoryCallback(ctx, chatId, historyAction);
            return;
        }

        await ctx.answerCallbackQuery({ text: UNKNOWN_ACTION_MESSAGE });
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
