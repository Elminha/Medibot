import { consultarBula } from "./services/bulaService.js";

const vectorStoreArgument = process.argv.find((argument) => argument.startsWith("--vector-store="));
const query = process.argv
    .slice(2)
    .filter((argument) => !argument.startsWith("--vector-store="))
    .join(" ");

if (!query) {
    throw new Error("Uso: npm run search:bula -- \"sua pergunta\" [--vector-store=vs_...]");
}

const result = await consultarBula(query, {
    vectorStoreId: vectorStoreArgument?.split("=")[1]
});

console.log(result.answer);

if (result.sources.length > 0) {
    console.log("\nFontes:");
    for (const source of result.sources) {
        console.log(`- ${source}`);
    }
}
