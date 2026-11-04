/**
 * Sem imports: usada tanto por bulaService.ts (resposta do assistente) quanto pelo
 * upload em lote (bulaUploadService.ts), que precisa funcionar em --dry-run sem
 * OPENAI_API_KEY configurada — importar algo que carregue config.ts quebraria isso.
 */

/** Converte um nome de arquivo de bula em um nome legível (ex.: "bula_ibuprofeno.pdf" -> "Ibuprofeno"). */
export function toReadableSourceName(filename: string): string {
    const withoutExtension = filename.replace(/\.[a-z0-9]+$/i, "");
    const withoutBulaPrefix = withoutExtension.replace(/^bula[\s_-]*/i, "");
    const normalized = withoutBulaPrefix.replace(/[_-]+/g, " ").trim();
    const base = normalized || withoutExtension.trim() || filename;

    return base
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => (/\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
        .join(" ");
}
