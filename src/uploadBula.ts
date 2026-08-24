import fs from "node:fs";
import path from "node:path";
import { gemini, getFileSearchStoreName } from "./config.js";

const pdfPath = process.argv[2];
const fileSearchStoreName = getFileSearchStoreName(process.argv[3]);

if (!pdfPath) {
    throw new Error("Uso: npm run upload:bula -- <caminho-do-pdf> [file-search-store-name]");
}

const resolvedPdfPath = path.resolve(pdfPath);

if (!fs.existsSync(resolvedPdfPath)) {
    throw new Error(`Arquivo não encontrado: ${resolvedPdfPath}`);
}

if (path.extname(resolvedPdfPath).toLowerCase() !== ".pdf") {
    throw new Error("A fonte de conhecimento deve ser um arquivo PDF.");
}

console.log("Enviando a bula para o Gemini e aguardando a indexação...");
let operation = await gemini.fileSearchStores.uploadToFileSearchStore({
    file: resolvedPdfPath,
    fileSearchStoreName,
    config: {
        displayName: path.basename(resolvedPdfPath),
        mimeType: "application/pdf"
    }
});

while (!operation.done) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    operation = await gemini.operations.get({ operation });
}

if (operation.error) {
    throw new Error(`A indexação falhou: ${JSON.stringify(operation.error)}`);
}

console.log("Bula indexada com sucesso.");
