export const FEEDBACK_TYPES = ["bug", "sugestao", "elogio", "outro"];
export const FEEDBACK_TYPE_LABELS = { bug: "Bug", sugestao: "Sugestão", elogio: "Elogio", outro: "Outro" };
export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;

const APP_VIEW_TO_FEEDBACK_VIEW = {
    chat: "chat",
    history: "historico",
    medications: "medicamentos",
    reminders: "lembretes",
    telegram: "telegram"
};

/** Traduz a view interna do app ("history", "medications"...) para o valor aceito pela API. */
export function mapAppViewToFeedbackView(appView) {
    return APP_VIEW_TO_FEEDBACK_VIEW[appView] ?? "chat";
}

/** mobile/desktop a partir do user agent — só isso é anexado automaticamente ao feedback. */
export function detectFeedbackDevice(userAgent) {
    return typeof userAgent === "string" && /android|iphone|ipad|ipod|mobile/i.test(userAgent)
        ? "mobile"
        : "desktop";
}

export function isValidFeedbackType(value) {
    return FEEDBACK_TYPES.includes(value);
}

export function isValidFeedbackRating(value) {
    return Number.isInteger(value) && value >= 1 && value <= 5;
}

/** Quantos caracteres ainda cabem na mensagem (pode ser negativo, para o contador). */
export function remainingFeedbackCharacters(message) {
    const length = typeof message === "string" ? message.length : 0;
    return FEEDBACK_MESSAGE_MAX_LENGTH - length;
}

/** Decide se o formulário pode ser enviado: tipo escolhido e mensagem de 1 a 2000 caracteres (sem contar espaços nas pontas). */
export function isFeedbackFormValid(type, message) {
    if (!isValidFeedbackType(type)) {
        return false;
    }

    const trimmedLength = typeof message === "string" ? message.trim().length : 0;
    return trimmedLength >= 1 && trimmedLength <= FEEDBACK_MESSAGE_MAX_LENGTH;
}

/** Texto do aviso acima do botão Enviar quando o envio está bloqueado; "" quando tudo está preenchido. */
export function getFeedbackBlockedHint(type, message) {
    if (!isValidFeedbackType(type)) {
        return "Escolha o tipo de feedback.";
    }

    const trimmedLength = typeof message === "string" ? message.trim().length : 0;
    if (trimmedLength < 1 || trimmedLength > FEEDBACK_MESSAGE_MAX_LENGTH) {
        return "Escreva uma mensagem.";
    }

    return "";
}
