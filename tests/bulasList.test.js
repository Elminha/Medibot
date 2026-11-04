import test from "node:test";
import assert from "node:assert/strict";
import { buildBulaQuestion, filterBulaNames, formatBulaCount } from "../public/bulasList.js";

const names = ["Acetilcisteína", "Ibuprofeno", "Losartana Potássica", "Paracetamol"];

test("filterBulaNames devolve tudo quando a busca está vazia", () => {
    assert.deepEqual(filterBulaNames(names, ""), names);
    assert.deepEqual(filterBulaNames(names, "   "), names);
});

test("filterBulaNames filtra ignorando caixa e acento", () => {
    assert.deepEqual(filterBulaNames(names, "acetil"), ["Acetilcisteína"]);
    assert.deepEqual(filterBulaNames(names, "IBUPRO"), ["Ibuprofeno"]);
    assert.deepEqual(filterBulaNames(names, "potassica"), ["Losartana Potássica"]);
});

test("filterBulaNames bate em qualquer posição do nome, não só no início", () => {
    assert.deepEqual(filterBulaNames(names, "tamol"), ["Paracetamol"]);
});

test("filterBulaNames devolve lista vazia quando nada bate", () => {
    assert.deepEqual(filterBulaNames(names, "dipirona"), []);
});

test("formatBulaCount usa singular para 1 e plural para o restante", () => {
    assert.equal(formatBulaCount(0), "0 bulas");
    assert.equal(formatBulaCount(1), "1 bula");
    assert.equal(formatBulaCount(2), "2 bulas");
});

test("buildBulaQuestion monta a pergunta padrão com o nome da bula", () => {
    assert.equal(buildBulaQuestion("Ibuprofeno"), "Para que serve o Ibuprofeno?");
});
