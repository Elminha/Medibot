import { gemini, getFileSearchStoreName } from "./config.js";

const fileSearchStoreArgument = process.argv.find((argument) => argument.startsWith("--file-search-store="));
const query = process.argv
    .slice(2)
    .filter((argument) => !argument.startsWith("--file-search-store="))
    .join(" ");
const fileSearchStoreName = getFileSearchStoreName(fileSearchStoreArgument?.split("=")[1]);
const fileSearchModel = "gemini-3.6-flash";

if (!query) {
    throw new Error("Uso: npm run search:bula -- \"sua pergunta\" [--file-search-store=fileSearchStores/...]");
}

const interaction = await gemini.interactions.create({
    model: fileSearchModel,
    input: query,
    system_instruction: [
        "Responda sempre em português do Brasil, com linguagem simples, clara e cotidiana.",
        "Não presuma que a pessoa conhece termos médicos, científicos ou técnicos.",
        "Prefira uma palavra comum quando ela transmitir o mesmo significado sem alterar a informação da bula.",
        "Quando um termo técnico for importante e não puder ser substituído, mantenha-o e explique-o imediatamente, de forma curta e compreensível, entre parênteses.",
        "Use exclusivamente as informações recuperadas pelo File Search da bula. Não invente explicações, informações ou detalhes que não estejam nos trechos recuperados.",
        "Simplifique a linguagem sem alterar o sentido da bula. Preserve obrigatoriamente condições, exceções, períodos, grupos específicos, idade, peso, frequência, duração e toda informação importante para a segurança do medicamento.",
        "Nunca transforme uma recomendação ou precaução em contraindicação. Nunca transforme uma contraindicação em recomendação. Não generalize informações com condições específicas e não omita exceções ou situações especiais.",
        "Não faça diagnóstico, não prescreva medicamentos e não recomende iniciar, interromper ou alterar tratamentos.",
        "Não recomende mudanças de dose, frequência, horário, duração ou forma de uso do medicamento.",
        "Organize a resposta em tópicos quando isso melhorar a compreensão.",
        "Se a informação solicitada não estiver presente nos trechos recuperados, responda exatamente: 'Essa informação não foi encontrada na bula fornecida.'"
    ].join(" "),
    tools: [{
        type: "file_search",
        file_search_store_names: [fileSearchStoreName]
    }]
});

let hasAnswer = false;
const citations = new Set<string>();

for (const step of interaction.steps) {
    if (step.type !== "model_output") {
        continue;
    }

    for (const contentBlock of step.content ?? []) {
        if (contentBlock.type !== "text") {
            continue;
        }

        if (contentBlock.text) {
            console.log(contentBlock.text);
            hasAnswer = true;
        }

        for (const annotation of contentBlock.annotations ?? []) {
            if (annotation.type === "file_citation") {
                const source = [
                    annotation.file_name,
                    annotation.page_number ? `página ${annotation.page_number}` : undefined
                ].filter(Boolean).join(" — ");

                if (source) {
                    citations.add(source);
                }
            }
        }
    }
}

if (!hasAnswer) {
    console.log("Essa informação não foi encontrada na bula fornecida.");
}

if (citations.size > 0) {
    console.log("\nFontes:");
    for (const citation of citations) {
        console.log(`- ${citation}`);
    }
} else {
    console.log("\nFontes: nenhuma fonte foi retornada pelo File Search.");
}
