import test from "node:test";
import assert from "node:assert/strict";
import { isPersonalDoseQuestion } from "../src/services/doseQuestionDetector.ts";

const CASOS_VERDADEIROS = [
    "qual a dose de dipirona pro meu filho de 10 kg?",
    "quantas gotas dou pra um bebe de 6 meses",
    "posso dar dipirona pra crianca de 5 anos",
    "qual a dose maxima diaria",
    "dipirona 500mg quantos comprimidos posso tomar",
    "de quanto em quanto tempo posso tomar ibuprofeno",
    "dose pra gravida",
    "qual a dosagem pro meu filho",
    "quanto devo tomar de dipirona",
    "quanto dar pra um bebe",
    "posologia pra minha filha de 3 anos"
];

const CASOS_FALSOS = [
    "para que serve a dipirona",
    "dipirona tem lactose",
    "efeitos colaterais do ibuprofeno",
    "posso tomar dipirona com alcool?",
    "o que é a nimesulida",
    "qual a posologia da dipirona",
    "qual a dosagem da amoxicilina",
    "o que a bula diz sobre o uso em criancas"
];

for (const pergunta of CASOS_VERDADEIROS) {
    test(`isPersonalDoseQuestion detecta pergunta de dose pessoal: "${pergunta}"`, () => {
        assert.equal(isPersonalDoseQuestion(pergunta), true);
    });
}

for (const pergunta of CASOS_FALSOS) {
    test(`isPersonalDoseQuestion não bloqueia pergunta informativa: "${pergunta}"`, () => {
        assert.equal(isPersonalDoseQuestion(pergunta), false);
    });
}

test("isPersonalDoseQuestion ignora acentuação e caixa", () => {
    assert.equal(isPersonalDoseQuestion("QUAL A DOSE MÁXIMA DIÁRIA?"), true);
    assert.equal(isPersonalDoseQuestion("Posso  dar   dipirona   pra   criança   de   5   anos"), true);
});
