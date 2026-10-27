import "dotenv/config";
import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
    throw new Error("OPENAI_API_KEY não foi configurada. Crie um arquivo .env.");
}

const DEFAULT_OPENAI_TIMEOUT_MS = 35_000;

export function getOpenAiTimeoutMs(): number {
    const configured = Number(process.env.OPENAI_TIMEOUT_MS);
    return configured > 0 ? configured : DEFAULT_OPENAI_TIMEOUT_MS;
}

// maxRetries: 0 porque o retry automático do SDK somaria tempo ao timeout, sem o bot
// conseguir avisar o usuário antes de o webhook do Telegram estourar o próprio prazo.
export const openai = new OpenAI({ apiKey, timeout: getOpenAiTimeoutMs(), maxRetries: 0 });
export const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

export function getVectorStoreId(argument?: string): string {
    const vectorStoreId = argument || process.env.VECTOR_STORE_ID;

    if (!vectorStoreId) {
        throw new Error(
            "VECTOR_STORE_ID não foi informado. Passe-o como argumento ou configure-o no .env."
        );
    }

    return vectorStoreId;
}
