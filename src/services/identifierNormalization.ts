const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BRAZIL_COUNTRY_CODE = "55";
const PHONE_CLEANUP_PATTERN = /[\s()\-.]/g;

export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
    }
}

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export function validateEmail(email: string): void {
    if (!EMAIL_PATTERN.test(email)) {
        throw new ValidationError("Informe um e-mail válido.");
    }
}

function validateBrazilianLocalNumber(localDigits: string): void {
    if (localDigits.length !== 10 && localDigits.length !== 11) {
        throw new ValidationError(
            "Telefone brasileiro inválido. Informe o DDD e o número (10 dígitos para fixo ou 11 para celular)."
        );
    }
}

/**
 * Normaliza telefones para E.164. Sem "+", assume-se Brasil (com ou sem o
 * DDI 55 já embutido no número); com "+", aceita-se qualquer país com 8 a 15 dígitos.
 */
export function normalizePhone(rawPhone: string): string {
    const cleaned = rawPhone.replace(PHONE_CLEANUP_PATTERN, "");
    if (!cleaned) {
        throw new ValidationError("Informe um telefone válido.");
    }

    const hasCountryCode = cleaned.startsWith("+");
    const digitsOnly = hasCountryCode ? cleaned.slice(1) : cleaned;

    if (!/^\d+$/.test(digitsOnly)) {
        throw new ValidationError("Telefone inválido. Use apenas números, parênteses, espaços, pontos ou hífens.");
    }

    if (hasCountryCode) {
        if (digitsOnly.length < 8 || digitsOnly.length > 15) {
            throw new ValidationError("Telefone inválido. Informe um número internacional com 8 a 15 dígitos.");
        }
        if (digitsOnly.startsWith(BRAZIL_COUNTRY_CODE)) {
            validateBrazilianLocalNumber(digitsOnly.slice(BRAZIL_COUNTRY_CODE.length));
        }
        return `+${digitsOnly}`;
    }

    if (digitsOnly.startsWith(BRAZIL_COUNTRY_CODE) && (digitsOnly.length === 12 || digitsOnly.length === 13)) {
        validateBrazilianLocalNumber(digitsOnly.slice(BRAZIL_COUNTRY_CODE.length));
        return `+${digitsOnly}`;
    }

    if (digitsOnly.length === 10 || digitsOnly.length === 11) {
        return `+${BRAZIL_COUNTRY_CODE}${digitsOnly}`;
    }

    throw new ValidationError("Telefone inválido. Informe o DDD e o número, com ou sem +55.");
}

export function isEmailLike(value: string): boolean {
    return value.includes("@");
}

export interface NormalizedIdentifier {
    type: "email" | "phone";
    value: string;
}

export function normalizeLoginIdentifier(rawIdentifier: string): NormalizedIdentifier {
    const trimmed = rawIdentifier.trim();
    if (!trimmed) {
        throw new ValidationError("Informe um e-mail ou telefone válido.");
    }

    if (isEmailLike(trimmed)) {
        const email = normalizeEmail(trimmed);
        validateEmail(email);
        return { type: "email", value: email };
    }

    return { type: "phone", value: normalizePhone(trimmed) };
}

export function assertHasEmailOrPhone(email: string | undefined, phone: string | undefined): void {
    if (!email && !phone) {
        throw new ValidationError("Informe ao menos um e-mail ou telefone para o cadastro.");
    }
}
