import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    throw new Error("GEMINI_API_KEY não foi configurada. Crie um arquivo .env.");
}

export const gemini = new GoogleGenAI({ apiKey });
export const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export function getFileSearchStoreName(argument?: string): string {
    const fileSearchStoreName = argument || process.env.FILE_SEARCH_STORE_NAME;

    if (!fileSearchStoreName) {
        throw new Error(
            "FILE_SEARCH_STORE_NAME não foi informado. Passe-o como argumento ou configure-o no .env."
        );
    }

    return fileSearchStoreName;
}
