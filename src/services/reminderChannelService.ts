import { getChatIdByUserId } from "./telegramLinkService.js";

export const REMINDER_CHANNELS = ["browser", "telegram"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export function isReminderChannel(value: unknown): value is ReminderChannel {
    return typeof value === "string" && (REMINDER_CHANNELS as readonly string[]).includes(value);
}

export class TelegramChannelRequiresLinkError extends Error {
    constructor() {
        super("Vincule sua conta do Telegram antes de ativar esse canal para este lembrete.");
        this.name = "TelegramChannelRequiresLinkError";
    }
}

/**
 * Valida a regra de negócio dos canais (vínculo do Telegram); a forma da lista
 * (valores válidos, sem duplicata, não vazia) já foi validada na rota
 * (reminderRoutes.ts). Devolve a lista normalizada (sem duplicatas, ordenada) para
 * persistência.
 */
export async function validateChannelsForUser(
    userId: number,
    channels: ReminderChannel[]
): Promise<ReminderChannel[]> {
    const unique = [...new Set(channels)].sort();

    if (unique.includes("telegram")) {
        const chatId = await getChatIdByUserId(userId);
        if (chatId === undefined) {
            throw new TelegramChannelRequiresLinkError();
        }
    }

    return unique;
}

interface ChannelWriteClient {
    query: (text: string, params?: unknown[]) => Promise<unknown>;
}

/** Substitui os canais de um lembrete (mesmo padrão de insertScheduleRows em reminderService.ts). */
export async function replaceReminderChannels(
    client: ChannelWriteClient,
    reminderId: number,
    channels: ReminderChannel[]
): Promise<void> {
    await client.query(`DELETE FROM reminder_channels WHERE reminder_id = $1;`, [reminderId]);
    for (const channel of channels) {
        await client.query(
            `INSERT INTO reminder_channels (reminder_id, channel) VALUES ($1, $2);`,
            [reminderId, channel]
        );
    }
}
