import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Cifragem de campos sensíveis (dado de saúde, LGPD art. 11) antes de gravar no banco.
 *
 * - Algoritmo: AES-256-GCM (cifra autenticada: um valor adulterado no banco falha ao
 *   decifrar, em vez de virar texto lixo).
 * - Chave: MEDICATION_ENCRYPTION_KEY, 32 bytes em base64, DIFERENTE por ambiente
 *   (Production x Preview). Se a chave for perdida, os valores cifrados com ela não
 *   podem mais ser lidos — guarde-a fora da Vercel também (gerenciador de senhas).
 * - Formato gravado: "enc:v1:" + base64(iv[12] | tag[16] | texto cifrado).
 * - Valores sem o prefixo são texto puro legado (gravados antes da cifragem) e são
 *   devolvidos como estão, para o sistema continuar funcionando durante a migração.
 */

const PREFIX = "enc:v1:";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export type EncryptedField = "medications.name" | "medications.dosage" | "medications.instructions";

export class EncryptionKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EncryptionKeyError";
    }
}

let cachedKey: { raw: string; key: Buffer } | undefined;

function getKey(): Buffer {
    const raw = process.env.MEDICATION_ENCRYPTION_KEY?.trim();
    if (!raw) {
        throw new EncryptionKeyError("MEDICATION_ENCRYPTION_KEY não foi configurada.");
    }
    if (cachedKey?.raw === raw) {
        return cachedKey.key;
    }
    const key = Buffer.from(raw, "base64");
    if (key.length !== KEY_LENGTH) {
        throw new EncryptionKeyError("MEDICATION_ENCRYPTION_KEY deve ter 32 bytes em base64.");
    }
    cachedKey = { raw, key };
    return key;
}

export function isEncryptionConfigured(): boolean {
    try {
        getKey();
        return true;
    } catch {
        return false;
    }
}

export function isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
}

/** O nome do campo entra como dado autenticado: um valor copiado de outra coluna não decifra. */
export function encryptField(field: EncryptedField, plaintext: string): string {
    const key = getKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(field, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptField(field: EncryptedField, stored: string): string {
    if (!isEncrypted(stored)) {
        return stored;
    }
    const payload = Buffer.from(stored.slice(PREFIX.length), "base64");
    if (payload.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error("Valor cifrado inválido.");
    }
    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAAD(Buffer.from(field, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptOptionalField(field: EncryptedField, value: string | null | undefined): string | null {
    return value === null || value === undefined ? null : encryptField(field, value);
}

export function decryptOptionalField(field: EncryptedField, value: string | null): string | null {
    return value === null ? null : decryptField(field, value);
}
