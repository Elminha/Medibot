import { getVectorStoreId, model, openai } from "../config.js";

const ANSWER_NOT_FOUND = "Essa informação não foi encontrada nas bulas disponíveis no sistema.";

const instructions = [
    "Você é o MediBot, um assistente educativo que responde exclusivamente com base nas bulas de medicamentos disponíveis no sistema.",
    "As bulas já estavam carregadas no sistema antes desta conversa. O usuário nunca envia arquivos: nunca diga 'documentos que você enviou', 'arquivos que você enviou' ou qualquer variação disso. Refira-se a elas sempre como 'as bulas disponíveis no sistema'.",
    "Responda sempre em português do Brasil, com linguagem simples, clara e cotidiana. Não presuma que a pessoa conhece termos médicos, científicos ou técnicos.",
    "Prefira uma palavra comum quando ela transmitir o mesmo significado sem alterar a informação da bula. Quando um termo técnico for importante e não puder ser substituído, mantenha-o e explique-o imediatamente, de forma curta e compreensível, entre parênteses.",
    "Use exclusivamente as informações recuperadas das bulas disponíveis no sistema pela busca interna. Não use conhecimento externo e não invente, suponha ou complete informações.",
    "Preserve obrigatoriamente condições, exceções, períodos, grupos específicos, idade, peso, frequência, duração e toda informação importante para a segurança do medicamento.",
    "Nunca transforme uma recomendação ou precaução em contraindicação. Nunca transforme uma contraindicação em recomendação. Não generalize informações com condições específicas e não omita exceções ou situações especiais.",
    "Não faça diagnóstico, não prescreva medicamentos e não recomende iniciar, interromper ou alterar tratamentos. Não recomende mudanças de dose, frequência, horário, duração ou forma de uso do medicamento.",
    "Se a própria bula trouxer uma orientação de segurança explícita, informe-a apenas como conteúdo da bula, sem criar uma recomendação personalizada.",
    "Se o usuário descrever sintomas, mal-estar ou problemas de saúde sem citar um medicamento específico, não sugira, não escolha e não indique qual medicamento usar. Em vez disso, explique que o MediBot apenas esclarece o que está escrito nas bulas de medicamentos específicos, convide a pessoa a perguntar sobre um medicamento em particular e recomende buscar orientação de um profissional de saúde.",
    "Se a mensagem do usuário for apenas uma saudação, um agradecimento ou uma conversa social, sem pergunta sobre um medicamento, responda de forma breve e natural, sem consultar as bulas e sem usar a busca interna.",
    "Quando houver trocas anteriores desta mesma conversa fornecidas como contexto, use-as para entender perguntas de acompanhamento (por exemplo, 'e esse medicamento serve para dor de cabeça também?'). Se o usuário perguntar de onde veio uma resposta anterior ou qual é a fonte dela, responda citando as fontes indicadas junto a essa resposta anterior no contexto, em vez de dizer que não tem acesso ao histórico.",
    "Organize a resposta em tópicos quando isso melhorar a compreensão.",
    `Se a informação solicitada não estiver nos trechos recuperados, responda exatamente: '${ANSWER_NOT_FOUND}'`
].join(" ");

export interface ConsultaBulaResultado {
    answer: string;
    sources: string[];
    /** true quando a busca interna nas bulas foi realmente usada (falso em cumprimentos/conversa social). */
    usedFileSearch: boolean;
}

export interface ConversationTurn {
    question: string;
    answer: string;
    sources: string[];
}

export interface ConsultarBulaOptions {
    vectorStoreId?: string;
    history?: ConversationTurn[];
}

interface ConversationMessage {
    role: "user" | "assistant";
    content: string;
}

/** Converte um nome de arquivo de bula em um nome legível (ex.: "bula_ibuprofeno.pdf" -> "Ibuprofeno"). */
export function toReadableSourceName(filename: string): string {
    const withoutExtension = filename.replace(/\.[a-z0-9]+$/i, "");
    const withoutBulaPrefix = withoutExtension.replace(/^bula[\s_-]*/i, "");
    const normalized = withoutBulaPrefix.replace(/[_-]+/g, " ").trim();
    const base = normalized || withoutExtension.trim() || filename;

    return base
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => (/\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
        .join(" ");
}

function dedupeReadableNames(filenames: Iterable<string>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const filename of filenames) {
        const readableName = toReadableSourceName(filename);
        if (!seen.has(readableName)) {
            seen.add(readableName);
            result.push(readableName);
        }
    }

    return result;
}

function buildConversationNote(sources: string[]): string {
    return sources.length > 0
        ? `\n\n(Fontes consultadas nesta resposta: ${sources.join(", ")})`
        : "";
}

/** Monta as mensagens de contexto (trocas anteriores + pergunta atual) na ordem cronológica esperada pela API. */
export function buildConversationInput(
    history: ConversationTurn[],
    question: string
): ConversationMessage[] {
    const messages: ConversationMessage[] = [];

    for (const turn of history) {
        messages.push({ role: "user", content: turn.question });
        messages.push({ role: "assistant", content: `${turn.answer}${buildConversationNote(turn.sources)}` });
    }

    messages.push({ role: "user", content: question });
    return messages;
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
    const input = buildConversationInput(options.history ?? [], question);

    const response = await openai.responses.create({
        model,
        instructions,
        input,
        tools: [{
            type: "file_search",
            vector_store_ids: [vectorStoreId]
        }],
        include: ["file_search_call.results"]
    });

    const citedFilenames = new Set<string>();
    let usedFileSearch = false;

    for (const output of response.output) {
        if (output.type === "file_search_call") {
            usedFileSearch = true;
            continue;
        }

        if (output.type !== "message") {
            continue;
        }

        for (const content of output.content) {
            if (content.type !== "output_text") {
                continue;
            }

            for (const annotation of content.annotations) {
                if (annotation.type === "file_citation") {
                    citedFilenames.add(annotation.filename);
                }
            }
        }
    }

    return {
        answer: response.output_text || ANSWER_NOT_FOUND,
        sources: dedupeReadableNames(citedFilenames),
        usedFileSearch
    };
}
