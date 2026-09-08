import { openai } from "./config.js";

const name = process.argv.slice(2).join(" ") || "MediBot - Bulas";
const vectorStore = await openai.vectorStores.create({ name });

console.log(`Vector Store criado com sucesso: ${vectorStore.id}`);
console.log(`Adicione VECTOR_STORE_ID=${vectorStore.id} ao seu arquivo .env.`);
