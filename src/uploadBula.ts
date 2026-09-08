import fs from "node:fs";
import path from "node:path";
import { getVectorStoreId, openai } from "./config.js";

const pdfPath = process.argv[2];
const vectorStoreId = getVectorStoreId(process.argv[3]);

if (!pdfPath) {
    throw new Error("Uso: npm run upload:bula -- <caminho-do-pdf> [vector-store-id]");
}

const resolvedPdfPath = path.resolve(pdfPath);

if (!fs.existsSync(resolvedPdfPath)) {
    throw new Error(`Arquivo não encontrado: ${resolvedPdfPath}`);
}

if (path.extname(resolvedPdfPath).toLowerCase() !== ".pdf") {
    throw new Error("A fonte de conhecimento deve ser um arquivo PDF.");
}

console.log("Enviando a bula para a OpenAI e aguardando a indexação...");
const vectorStoreFile = await openai.vectorStores.files.uploadAndPoll(
    vectorStoreId,
    fs.createReadStream(resolvedPdfPath)
);

if (vectorStoreFile.status !== "completed") {
    throw new Error(
        `A indexação falhou: ${vectorStoreFile.last_error?.message || vectorStoreFile.status}`
    );
}

console.log("Bula indexada com sucesso.");
