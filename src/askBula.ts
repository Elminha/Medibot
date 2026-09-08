import { consultarBula } from "./services/bulaService.js";

const vectorStoreArgument = process.argv.find((argument) => argument.startsWith("--vector-store="));
const question = process.argv
    .slice(2)
    .filter((argument) => !argument.startsWith("--vector-store="))
    .join(" ");

if (!question) {
    throw new Error("Uso: npm run ask:bula -- \"sua pergunta\" [--vector-store=vs_...]");
}

const result = await consultarBula(question, {
    vectorStoreId: vectorStoreArgument?.split("=")[1]
});

console.log(result.answer);
