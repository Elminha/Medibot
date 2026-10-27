/**
 * Classificador determinístico usado como trava antes de qualquer chamada à OpenAI:
 * detecta perguntas que pedem dose, quantidade ou frequência de uso para uma pessoa
 * (principalmente crianças, gestantes e lactantes). O MediBot é educativo e nunca deve
 * calcular ou indicar dose para ninguém, então essa verificação precisa ser puramente
 * baseada em texto, sem depender do modelo obedecer a uma instrução.
 */

const NUMERO = "\\d+|zero|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze";

const DOSE_RE = /\bdoses?\b/;
const INTERVALO_RE = /\b(de\s+quanto\s+em\s+quanto\s+tempo|intervalo\s+entre\s+(as\s+)?doses?|quantas?\s+vezes\s+(ao|por)\s+dia)\b/;
const PESO_RE = new RegExp(`\\b(${NUMERO})\\s*(kg|quilos?|quilogramas?)\\b`);
const IDADE_RE = new RegExp(`\\b(${NUMERO})\\s*(anos?|meses|mes)\\b`);
const QUANTIDADE_RE = /\bquant(o|a|os|as|idade)\b/;
const FORMA_FARMACEUTICA_RE = /\b(gotas?|comprimidos?|capsulas?|colheres?|ml|mg|mililitros?|miligramas?)\b/;
const POSSO_DAR_TOMAR_RE = /\b(posso|devo|vou|pode(mos)?)\s+(dar|tomar)\b/;
const CRIANCA_RE = /\b(crianca|criancas|bebe|bebes|filho|filha|filhos|filhas|neto|neta|netos|netas|recem[\s-]?nascidos?|pediatric[oa]s?)\b/;
const GRAVIDEZ_RE = /\b(gravida|gravidas|gestante|gestantes|amamentando|lactante|lactantes|amamentacao)\b/;
const DOSAGEM_POSOLOGIA_RE = /\b(dosagem|posologia)\b/;
const PESSOA_MARCADOR_RE = /\b(meu|minha|pro|pra|para\s+(o|a))\b[^.!?\n]{0,12}\b(filho|filha|bebe|bebes|crianca|criancas|neto|neta|mim|ela|ele)\b/;
const QUANTO_DAR_TOMAR_RE = /\bquanto\s+(devo\s+|posso\s+|preciso\s+|dou\s+)?(tomar|dar)\b/;

function normalizar(texto: string): string {
    return texto
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

/** true quando a pergunta pede dose, quantidade ou frequência de uso para uma pessoa específica. */
export function isPersonalDoseQuestion(texto: string): boolean {
    const normalizado = normalizar(texto);

    if (DOSE_RE.test(normalizado)) {
        return true;
    }

    if (INTERVALO_RE.test(normalizado)) {
        return true;
    }

    if (PESO_RE.test(normalizado)) {
        return true;
    }

    const pedeQuantidade = QUANTIDADE_RE.test(normalizado) && FORMA_FARMACEUTICA_RE.test(normalizado);
    if (pedeQuantidade) {
        return true;
    }

    const pessoaAlvo = CRIANCA_RE.test(normalizado) || GRAVIDEZ_RE.test(normalizado);
    const pedeParaDar = POSSO_DAR_TOMAR_RE.test(normalizado) && (QUANTIDADE_RE.test(normalizado) || pessoaAlvo);
    if (pedeParaDar) {
        return true;
    }

    if (IDADE_RE.test(normalizado) && (pessoaAlvo || QUANTIDADE_RE.test(normalizado) || POSSO_DAR_TOMAR_RE.test(normalizado))) {
        return true;
    }

    const dosagemOuPosologiaPessoal = DOSAGEM_POSOLOGIA_RE.test(normalizado)
        && (PESSOA_MARCADOR_RE.test(normalizado) || PESO_RE.test(normalizado) || IDADE_RE.test(normalizado) || pessoaAlvo);
    if (dosagemOuPosologiaPessoal) {
        return true;
    }

    if (QUANTO_DAR_TOMAR_RE.test(normalizado)) {
        return true;
    }

    return false;
}
