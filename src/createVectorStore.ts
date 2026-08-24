import { gemini } from "./config.js";

const name = process.argv.slice(2).join(" ") || "MediBot - Bulas";
const fileSearchStore = await gemini.fileSearchStores.create({
    config: { displayName: name }
});

if (!fileSearchStore.name) {
    throw new Error("O Gemini não retornou o nome do File Search Store.");
}

console.log(`File Search Store criado com sucesso: ${fileSearchStore.name}`);
console.log(`Adicione FILE_SEARCH_STORE_NAME=${fileSearchStore.name} ao seu arquivo .env.`);
