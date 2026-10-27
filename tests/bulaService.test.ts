import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// O config.ts lança erro se OPENAI_API_KEY/VECTOR_STORE_ID não estiverem definidas (mesmo nunca
// chamando a API de verdade aqui, pois openai.responses.create é mockado). Definimos valores
// fictícios ANTES do import dinâmico para não depender de segredos reais nem de rede.
process.env.OPENAI_API_KEY ||= "test-key";
process.env.VECTOR_STORE_ID ||= "vs_test";

const { openai } = await import("../src/config.ts");
const { buildConversationInput, consultarBula, toReadableSourceName } = await import("../src/services/bulaService.ts");

function mockResponseOnce(response: unknown): void {
    mock.method(openai.responses, "create", async () => response as never);
}

test.afterEach(() => {
    mock.restoreAll();
});

test("toReadableSourceName converte nomes de arquivo em nomes legíveis", () => {
    assert.equal(toReadableSourceName("bula_ibuprofeno.pdf"), "Ibuprofeno");
    assert.equal(toReadableSourceName("Bula - Dipirona.PDF"), "Dipirona");
    assert.equal(toReadableSourceName("paracetamol_500mg.pdf"), "Paracetamol 500mg");
});

test("buildConversationInput intercala histórico e pergunta atual em ordem cronológica", () => {
    const input = buildConversationInput(
        [{ question: "O que é ibuprofeno?", answer: "É um anti-inflamatório.", sources: ["Ibuprofeno"] }],
        "De onde você tirou isso?"
    );

    assert.equal(input.length, 3);
    assert.deepEqual(input[0], { role: "user", content: "O que é ibuprofeno?" });
    assert.equal(input[1].role, "assistant");
    assert.match(input[1].content, /É um anti-inflamatório\./);
    assert.match(input[1].content, /Ibuprofeno/);
    assert.deepEqual(input[2], { role: "user", content: "De onde você tirou isso?" });
});

test("consultarBula usa apenas os arquivos citados na resposta, não todos os resultados da busca", async () => {
    mockResponseOnce({
        output_text: "O ibuprofeno é um anti-inflamatório.",
        output: [
            {
                type: "file_search_call",
                results: [
                    { filename: "bula_ibuprofeno.pdf" },
                    { filename: "bula_paracetamol.pdf" },
                    { filename: "bula_dipirona.pdf" }
                ]
            },
            {
                type: "message",
                content: [
                    {
                        type: "output_text",
                        text: "O ibuprofeno é um anti-inflamatório.",
                        annotations: [{ type: "file_citation", filename: "bula_ibuprofeno.pdf" }]
                    }
                ]
            }
        ]
    });

    const resultado = await consultarBula("O que é ibuprofeno?");

    assert.deepEqual(resultado.sources, ["Ibuprofeno"]);
    assert.equal(resultado.usedFileSearch, true);
});

test("consultarBula remove duplicatas e usa nomes legíveis quando o mesmo arquivo é citado mais de uma vez", async () => {
    mockResponseOnce({
        output_text: "Resposta com duas citações do mesmo arquivo.",
        output: [
            {
                type: "message",
                content: [
                    {
                        type: "output_text",
                        text: "Resposta com duas citações do mesmo arquivo.",
                        annotations: [
                            { type: "file_citation", filename: "bula_ibuprofeno.pdf" },
                            { type: "file_citation", filename: "bula_ibuprofeno.pdf" }
                        ]
                    }
                ]
            }
        ]
    });

    const resultado = await consultarBula("pergunta qualquer");

    assert.deepEqual(resultado.sources, ["Ibuprofeno"]);
});

test("consultarBula retorna fontes vazias quando nada foi citado, mesmo com usedFileSearch verdadeiro", async () => {
    mockResponseOnce({
        output_text: "",
        output: [
            { type: "file_search_call", results: [{ filename: "bula_ibuprofeno.pdf" }] },
            { type: "message", content: [{ type: "output_text", text: "", annotations: [] }] }
        ]
    });

    const resultado = await consultarBula("pergunta sobre algo não encontrado");

    assert.deepEqual(resultado.sources, []);
    assert.equal(resultado.usedFileSearch, true);
    assert.match(resultado.answer, /não foi encontrada/);
});

test("consultarBula não marca usedFileSearch em respostas de conversa social (sem busca)", async () => {
    mockResponseOnce({
        output_text: "Olá! Como posso ajudar?",
        output: [
            { type: "message", content: [{ type: "output_text", text: "Olá! Como posso ajudar?", annotations: [] }] }
        ]
    });

    const resultado = await consultarBula("oi");

    assert.deepEqual(resultado.sources, []);
    assert.equal(resultado.usedFileSearch, false);
});

test("consultarBula bloqueia pergunta de dose pessoal sem chamar a OpenAI", async () => {
    const createMock = mock.method(openai.responses, "create", async () => {
        throw new Error("openai.responses.create não deveria ser chamado para pergunta de dose pessoal");
    });

    const resultado = await consultarBula("qual a dose de dipirona pro meu filho de 10 kg?");

    assert.equal(createMock.mock.callCount(), 0);
    assert.deepEqual(resultado.sources, []);
    assert.equal(resultado.usedFileSearch, false);
    assert.match(resultado.answer, /não calcula nem indica doses/);
});

test("consultarBula remove do histórico perguntas de dose pessoal antes de consultar o modelo", async () => {
    mockResponseOnce({
        output_text: "O ibuprofeno é um anti-inflamatório.",
        output: [
            { type: "message", content: [{ type: "output_text", text: "O ibuprofeno é um anti-inflamatório.", annotations: [] }] }
        ]
    });

    const historicoComPerguntaBloqueada = [
        {
            question: "qual a dose de dipirona pro meu filho de 10 kg?",
            answer: "O MediBot é educativo e não calcula nem indica doses...",
            sources: []
        }
    ];

    await consultarBula("o que é ibuprofeno?", { history: historicoComPerguntaBloqueada });

    const chamada = (openai.responses.create as unknown as ReturnType<typeof mock.method>).mock.calls[0];
    const input = (chamada.arguments[0] as { input: Array<{ content: string }> }).input;

    assert.equal(input.length, 1);
    assert.deepEqual(input[0], { role: "user", content: "o que é ibuprofeno?" });
});
