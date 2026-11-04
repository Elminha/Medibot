/** Mascara um e-mail para exibição ("leandro.cortes@gmail.com" -> "le***@g***.com"). */
export function maskEmail(email) {
    if (typeof email !== "string" || !email) return "";

    const atIndex = email.indexOf("@");
    if (atIndex <= 0) return email;

    const local = email.slice(0, atIndex);
    const domain = email.slice(atIndex + 1);
    const maskedLocal = local.length <= 2 ? `${local[0]}***` : `${local.slice(0, 2)}***`;

    const dotIndex = domain.lastIndexOf(".");
    if (dotIndex <= 0) return `${maskedLocal}@${domain}`;

    const domainName = domain.slice(0, dotIndex);
    const tld = domain.slice(dotIndex);
    const maskedDomain = domainName.length <= 1 ? `${domainName}***` : `${domainName[0]}***`;

    return `${maskedLocal}@${maskedDomain}${tld}`;
}

/** Texto do botão de reenvio durante o cooldown, ou "" quando já pode reenviar. */
export function formatResendCooldownLabel(remainingMs) {
    if (!(remainingMs > 0)) return "";
    const seconds = Math.ceil(remainingMs / 1000);
    return `Reenviar em ${seconds}s`;
}

/**
 * O que fazer depois de confirmar o e-mail com sucesso: se este navegador já tem uma
 * sessão guardada (ex.: a pessoa estava na tela "Confirme seu e-mail" e abriu o link em
 * outra aba do mesmo navegador), entra direto no app sem precisar sair e logar de novo;
 * sem sessão guardada, manda para a tela de login.
 */
export function resolveAfterVerificationAction(hasStoredAuthToken) {
    return hasStoredAuthToken ? "continue-session" : "go-to-login";
}
