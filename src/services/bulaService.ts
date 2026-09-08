import { getVectorStoreId, model, openai } from "../config.js";

const ANSWER_NOT_FOUND = "Essa informação não foi encontrada na bula fornecida.";

const instructions = [
    "Responda sempre em português do Brasil, com linguagem simples, clara e cotidiana.",
    "Não presuma que a pessoa conhece termos médicos, científicos ou técnicos.",
    "Prefira uma palavra comum quando ela transmitir o mesmo significado sem alterar a informação da bula.",
    "Quando um termo técnico for importante e não puder ser substituído, mantenha-o e explique-o imediatamente, de forma curta e compreensível, entre parênteses.",
    "Use exclusivamente as informações recuperadas da bula pelo File Search. Não use conhecimento externo e não invente, suponha ou complete informações.",
    "Preserve obrigatoriamente condições, exceções, períodos, grupos específicos, idade, peso, frequência, duração e toda informação importante para a segurança do medicamento.",
    "Nunca transforme uma recomendação ou precaução em contraindicação. Nunca transforme uma contraindicação em recomendação. Não generalize informações com condições específicas e não omita exceções ou situações especiais.",
    "Não faça diagnóstico, não prescreva medicamentos e não recomende iniciar, interromper ou alterar tratamentos.",
    "Não recomende mudanças de dose, frequência, horário, duração ou forma de uso do medicamento.",
    "Se a própria bula trouxer uma orientação de segurança explícita, informe-a apenas como conteúdo da bula, sem criar uma recomendação personalizada.",
    "Organize a resposta em tópicos quando isso melhorar a compreensão.",
    `Se a informação solicitada não estiver nos trechos recuperados, responda exatamente: '${ANSWER_NOT_FOUND}'`
].join(" ");

export interface ConsultaBulaResultado {
    answer: string;
    sources: string[];
}

export interface ConsultarBulaOptions {
    vectorStoreId?: string;
}

/** Consulta exclusivamente as bulas indexadas no Vector Store configurado. */
export async function consultarBula(
    pergunta: string,
    options: ConsultarBulaOptions = {}
): Promise<ConsultaBulaResultado> {
    const question = pergunta.trim();

    if (!question) {
        throw new Error("A pergunta para consultar a bula é obrigatória.");
    }

    const vectorStoreId = getVectorStoreId(options.vectorStoreId);
    const response = await openai.responses.create({
        model,
        instructions,
        input: question,
        tools: [{
            type: "file_search",
            vector_store_ids: [vectorStoreId]
        }],
        include: ["file_search_call.results"]
    });

    const sources = new Set<string>();

    for (const output of response.output) {
        if (output.type === "message") {
            for (const content of output.content) {
                if (content.type !== "output_text") {
                    continue;
                }

                for (const annotation of content.annotations) {
                    if (annotation.type === "file_citation") {
                        sources.add(annotation.filename);
                    }
                }
            }
        }

        if (output.type === "file_search_call") {
            for (const result of output.results || []) {
                if (result.filename) {
                    sources.add(result.filename);
                }
            }
        }
    }

    return {
        answer: response.output_text || ANSWER_NOT_FOUND,
        sources: [...sources]
    };
}
