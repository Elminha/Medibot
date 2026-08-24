import { gemini, getFileSearchStoreName, model } from "./config.js";

const fileSearchStoreArgument = process.argv.find((argument) => argument.startsWith("--file-search-store="));
const question = process.argv
    .slice(2)
    .filter((argument) => !argument.startsWith("--file-search-store="))
    .join(" ");
const fileSearchStoreName = getFileSearchStoreName(fileSearchStoreArgument?.split("=")[1]);

if (!question) {
    throw new Error("Uso: npm run ask:bula -- \"sua pergunta\" [--file-search-store=fileSearchStores/...]");
}

const response = await gemini.models.generateContent({
    model,
    contents: question,
    config: {
        systemInstruction:
            "Responda em português usando exclusivamente as bulas recuperadas. " +
            "Se a resposta não estiver nas bulas, diga que não há informação suficiente na bula. " +
            "Não invente, complete ou use conhecimento externo. Não faça diagnóstico.",
        tools: [{
            fileSearch: {
                fileSearchStoreNames: [fileSearchStoreName]
            }
        }]
    }
});

console.log(response.text || "Não encontrei informação suficiente na bula para responder.");
