export const TELEGRAM_HOURLY_QUESTION_LIMIT = 20;

/**
 * Decide se o limite de perguntas por hora foi atingido, a partir da contagem
 * já calculada (ex.: linhas em `queries` para o usuário na última hora).
 * Função pura para ser testável sem depender do banco de dados.
 */
export function hasExceededHourlyLimit(
    recentQuestionCount: number,
    limit: number = TELEGRAM_HOURLY_QUESTION_LIMIT
): boolean {
    return recentQuestionCount >= limit;
}
