/** Remove acentos/caixa para a busca ignorar os dois ("icuprofeno" não bate, "ibuprofeno" sim). */
function normalizeForSearch(value) {
    return (typeof value === "string" ? value : "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .trim();
}

/** Filtra os nomes de bula pelo texto digitado (sem acento/caixa, substring em qualquer posição). */
export function filterBulaNames(names, query) {
    const normalizedQuery = normalizeForSearch(query);
    if (!normalizedQuery) return [...names];
    return names.filter((name) => normalizeForSearch(name).includes(normalizedQuery));
}

/** Texto do contador ("1 bula" / "N bulas"), já considerando o plural. */
export function formatBulaCount(count) {
    return count === 1 ? "1 bula" : `${count} bulas`;
}

export function buildBulaQuestion(name) {
    return `Para que serve o ${name}?`;
}
