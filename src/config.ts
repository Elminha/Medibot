import "dotenv/config";
import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
    throw new Error("OPENAI_API_KEY não foi configurada. Crie um arquivo .env.");
}

export const openai = new OpenAI({ apiKey });
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
