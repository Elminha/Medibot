import { createHash } from "node:crypto";
import { toReadableSourceName } from "./bulaSourceName.js";

/**
 * bula_<nome>.pdf: minúsculo, sem acento/espaço/caractere especial — só letras,
 * números, "_" ou "-" no nome, e extensão ".pdf" minúscula.
 */
const BULA_FILENAME_PATTERN = /^bula_[a-z0-9_-]+\.pdf$/;

export const PDF_MAGIC_BYTES = "%PDF-";
export const MIN_BULA_FILE_SIZE_BYTES = 10 * 1024;
export const MAX_BULA_FILE_SIZE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_DELAY_BETWEEN_FILES_MS = 500;
export const DEFAULT_RETRY_COUNT = 1;

export function isValidBulaFilename(filename: string): boolean {
    return BULA_FILENAME_PATTERN.test(filename);
}

/** O conteúdo começa com a assinatura "%PDF-"; não garante que o PDF é válido além disso. */
export function hasValidPdfHeader(buffer: Buffer): boolean {
    return buffer.subarray(0, PDF_MAGIC_BYTES.length).toString("latin1") === PDF_MAGIC_BYTES;
}

export function isValidBulaFileSize(sizeBytes: number): boolean {
    return sizeBytes >= MIN_BULA_FILE_SIZE_BYTES && sizeBytes <= MAX_BULA_FILE_SIZE_BYTES;
}

export function computeSha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

/** Erro de upload que vale tentar de novo (rede instável, rate limit, erro 5xx temporário da OpenAI). */
export class TransientUploadError extends Error {}

/**
 * Duck-typing deliberado: não depende do SDK da OpenAI (mantém este módulo livre da
 * dependência de config.ts/OPENAI_API_KEY, necessária para o --dry-run funcionar sem chave).
 */
export function isTransientOpenAiError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }

    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && [408, 429, 500, 502, 503, 504].includes(status)) {
        return true;
    }

    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(code);
}

/** Troca qualquer segredo conhecido (ex.: a API key) por "[REDACTED]" antes de logar algo. */
export function redactSecrets(message: string, secrets: Array<string | undefined>): string {
    let redacted = message;
    for (const secret of secrets) {
        if (secret && secret.length >= 6) {
            redacted = redacted.split(secret).join("[REDACTED]");
        }
    }
    return redacted;
}

/** Mensagem amigável, sem stack trace; qualquer `secrets` é redigido antes de retornar. */
export function describeUploadError(error: unknown, secrets: Array<string | undefined> = []): string {
    const message = error instanceof Error ? error.message : "Erro desconhecido ao enviar o arquivo.";
    return redactSecrets(message, secrets);
}

/**
 * "upload": enviado de verdade pelo lote (tem openaiFileId). "legado": já estava indexado
 * no Vector Store antes do manifesto existir, só registrado aqui via --registrar-existentes
 * (nunca foi enviado por este código, por isso não tem openaiFileId).
 */
export type ManifestEntryOrigin = "upload" | "legado";

export interface ManifestEntry {
    filename: string;
    sha256: string;
    openaiFileId?: string;
    uploadedAt: string;
    origin: ManifestEntryOrigin;
}

export type Manifest = ManifestEntry[];

export class ManifestParseError extends Error {}

/** "" (arquivo novo) -> manifesto vazio; conteúdo malformado -> erro explícito (não ignora silenciosamente). */
export function parseManifest(raw: string): Manifest {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return [];
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new ManifestParseError("O manifesto bulas/uploaded.json não é um JSON válido.");
    }

    if (!Array.isArray(parsed)) {
        throw new ManifestParseError("O manifesto bulas/uploaded.json deveria conter uma lista.");
    }

    for (const entry of parsed) {
        const candidate = entry as Partial<ManifestEntry> & Record<string, unknown>;
        const isValidEntry = entry && typeof entry === "object"
            && typeof candidate.filename === "string"
            && typeof candidate.sha256 === "string"
            && typeof candidate.uploadedAt === "string"
            && (candidate.openaiFileId === undefined || typeof candidate.openaiFileId === "string")
            && (candidate.origin === undefined || candidate.origin === "upload" || candidate.origin === "legado");

        if (!isValidEntry) {
            throw new ManifestParseError("O manifesto bulas/uploaded.json tem um registro em formato inesperado.");
        }
    }

    return (parsed as Array<Partial<ManifestEntry>>).map((entry) => ({
        filename: entry.filename as string,
        sha256: entry.sha256 as string,
        ...(entry.openaiFileId !== undefined ? { openaiFileId: entry.openaiFileId } : {}),
        uploadedAt: entry.uploadedAt as string,
        origin: entry.origin ?? "upload"
    }));
}

/** Ordenado por nome de arquivo para o diff do git ficar estável/legível. */
export function serializeManifest(manifest: Manifest): string {
    const sorted = [...manifest].sort((a, b) => a.filename.localeCompare(b.filename));
    return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function findManifestEntryByFilename(manifest: Manifest, filename: string): ManifestEntry | undefined {
    return manifest.find((entry) => entry.filename === filename);
}

export function findManifestEntryBySha256(manifest: Manifest, sha256: string): ManifestEntry | undefined {
    return manifest.find((entry) => entry.sha256 === sha256);
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const key = keyOf(item);
        const group = groups.get(key);
        if (group) {
            group.push(item);
        } else {
            groups.set(key, [item]);
        }
    }
    return groups;
}

export type BatchFileStatus = "enviado" | "pulado" | "erro" | "pronto_para_envio";

export interface BatchFileResult {
    filename: string;
    sourceName?: string;
    status: BatchFileStatus;
    errors: string[];
    warnings: string[];
    openaiFileId?: string;
}

export interface BatchUploadSummary {
    results: BatchFileResult[];
    sentCount: number;
    skippedCount: number;
    errorCount: number;
    readyCount: number;
    /** Quantos arquivos têm ao menos um aviso (ex.: Fonte repetida) — não bloqueia o envio. */
    warningCount: number;
}

export interface BatchUploadDeps {
    listPdfFilenames: (folderPath: string) => Promise<string[]>;
    readFileBuffer: (folderPath: string, filename: string) => Promise<Buffer>;
    readManifest: () => Promise<Manifest>;
    writeManifest: (manifest: Manifest) => Promise<void>;
    uploadFile: (folderPath: string, filename: string, buffer: Buffer) => Promise<{ fileId: string }>;
    sleep: (ms: number) => Promise<void>;
    now: () => Date;
    log: (line: string) => void;
    secrets?: Array<string | undefined>;
}

export interface BatchUploadOptions {
    dryRun: boolean;
    delayMs?: number;
    retryCount?: number;
}

interface FileInfo {
    filename: string;
    buffer?: Buffer;
    sha256?: string;
    sourceName?: string;
    skip: boolean;
    errors: string[];
    warnings: string[];
}

/**
 * Processa todos os PDFs de `folderPath`, um por vez, em sequência. Todas as validações
 * (nome, cabeçalho/tamanho do PDF, duplicados por conteúdo/Fonte) rodam ANTES de qualquer
 * envio, mesmo em --dry-run — `deps.uploadFile` só é chamado quando `options.dryRun` é falso.
 */
export async function runBatchUpload(
    folderPath: string,
    options: BatchUploadOptions,
    deps: BatchUploadDeps
): Promise<BatchUploadSummary> {
    const delayMs = options.delayMs ?? DEFAULT_DELAY_BETWEEN_FILES_MS;
    const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
    const secrets = deps.secrets ?? [];

    const filenames = [...await deps.listPdfFilenames(folderPath)].sort();
    const manifest = await deps.readManifest();

    const infos: FileInfo[] = [];

    for (const filename of filenames) {
        const info: FileInfo = { filename, skip: false, errors: [], warnings: [] };

        // Checado ANTES da validação estrita de nome: uma bula já registrada (inclusive
        // "legado", com nome antigo fora do padrão novo) deve ser pulada como "já enviado",
        // não rejeitada por nome — senão um lote normal nunca conseguiria pular os legados.
        const existingByFilename = findManifestEntryByFilename(manifest, filename);
        if (existingByFilename) {
            info.skip = true;
            info.sourceName = toReadableSourceName(filename);
            infos.push(info);
            continue;
        }

        if (!isValidBulaFilename(filename)) {
            info.errors.push(
                'Nome de arquivo fora do padrão esperado: use "bula_<nome>.pdf", minúsculo, sem acento, '
                + 'espaço ou caractere especial (só letras, números, "_" ou "-").'
            );
            infos.push(info);
            continue;
        }

        info.sourceName = toReadableSourceName(filename);

        let buffer: Buffer;
        try {
            buffer = await deps.readFileBuffer(folderPath, filename);
        } catch (error) {
            info.errors.push(`Não foi possível ler o arquivo: ${describeUploadError(error, secrets)}`);
            infos.push(info);
            continue;
        }
        info.buffer = buffer;

        if (!hasValidPdfHeader(buffer)) {
            info.errors.push(`Não parece ser um PDF válido (não começa com "${PDF_MAGIC_BYTES}").`);
        }

        if (!isValidBulaFileSize(buffer.length)) {
            info.errors.push(
                `Tamanho fora do esperado (entre ${MIN_BULA_FILE_SIZE_BYTES / 1024} KB e `
                + `${MAX_BULA_FILE_SIZE_BYTES / (1024 * 1024)} MB): ${buffer.length} bytes.`
            );
        }

        info.sha256 = computeSha256(buffer);
        const existingByHash = findManifestEntryBySha256(manifest, info.sha256);
        if (existingByHash) {
            info.errors.push(
                `Mesmo conteúdo (SHA-256) já enviado anteriormente como "${existingByHash.filename}".`
            );
        }

        // Mesma Fonte que algo já no manifesto (upload OU legado), mas conteúdo diferente: não é
        // necessariamente um erro (pode ser uma atualização da bula), então só avisa — não bloqueia.
        const sourceNameCollision = manifest.find(
            (entry) => entry.sha256 !== info.sha256 && toReadableSourceName(entry.filename) === info.sourceName
        );
        if (sourceNameCollision) {
            info.warnings.push(
                `Já existe uma bula com a Fonte "${info.sourceName}" no manifesto (arquivo "${sourceNameCollision.filename}"): `
                + "confirme que não é duplicada."
            );
        }

        infos.push(info);
    }

    // Duplicados dentro do PRÓPRIO lote (não contra o manifesto): mesma Fonte ou mesmo hash.
    const consideredInfos = infos.filter((info) => !info.skip);

    for (const group of groupBy(consideredInfos.filter((info) => info.sourceName), (info) => info.sourceName as string).values()) {
        if (group.length > 1) {
            const names = group.map((info) => info.filename).join(", ");
            for (const info of group) {
                info.errors.push(`Duas bulas deste lote gerariam a mesma Fonte ("${info.sourceName}"): ${names}.`);
            }
        }
    }

    for (const group of groupBy(consideredInfos.filter((info) => info.sha256), (info) => info.sha256 as string).values()) {
        if (group.length > 1) {
            const names = group.map((info) => info.filename).join(", ");
            for (const info of group) {
                info.errors.push(`Mesmo conteúdo (SHA-256) que outro arquivo deste lote: ${names}.`);
            }
        }
    }

    // "pronto_para_envio" é o estado inicial de qualquer arquivo elegível, em dry-run ou não;
    // numa execução real, o laço abaixo troca esse estado para "enviado" ou "erro" depois de tentar.
    const results: BatchFileResult[] = infos.map((info) => ({
        filename: info.filename,
        sourceName: info.sourceName,
        status: info.skip ? "pulado" : info.errors.length > 0 ? "erro" : "pronto_para_envio",
        errors: info.errors,
        warnings: info.warnings
    }));

    deps.log("");
    deps.log("Validação (antes de qualquer envio):");
    for (const result of results) {
        const sourceLabel = result.sourceName ? `Fonte: "${result.sourceName}"` : "Fonte: (não calculada)";
        deps.log(`- ${result.filename} — ${sourceLabel} — ${result.status}`);
        for (const error of result.errors) {
            deps.log(`  ! ${error}`);
        }
        for (const warning of result.warnings) {
            deps.log(`  ? AVISO: ${warning}`);
        }
    }
    deps.log("");

    if (options.dryRun) {
        return summarize(results);
    }

    // liveManifest é persistido a cada sucesso, para uma falha no meio do lote não perder o progresso já feito.
    const liveManifest: Manifest = [...manifest];
    let isFirstSend = true;

    for (let index = 0; index < infos.length; index += 1) {
        const info = infos[index];
        const result = results[index];

        if (result.status !== "pronto_para_envio") {
            continue;
        }
        if (!info.buffer || info.sha256 === undefined) {
            continue; // nunca deveria acontecer (elegível implica buffer+hash já calculados).
        }

        if (!isFirstSend) {
            await deps.sleep(delayMs);
        }
        isFirstSend = false;

        try {
            const uploaded = await uploadWithRetry(deps, folderPath, info.filename, info.buffer, retryCount, secrets);
            result.status = "enviado";
            result.errors = [];
            result.openaiFileId = uploaded.fileId;

            liveManifest.push({
                filename: info.filename,
                sha256: info.sha256,
                openaiFileId: uploaded.fileId,
                uploadedAt: deps.now().toISOString(),
                origin: "upload"
            });
            await deps.writeManifest(liveManifest);
            deps.log(`OK: "${info.filename}" enviado e indexado (Fonte: "${info.sourceName}").`);
        } catch (error) {
            result.status = "erro";
            result.errors = [describeUploadError(error, secrets)];
            deps.log(`ERRO: "${info.filename}" não foi enviado — ${result.errors[0]}`);
        }
    }

    return summarize(results);
}

async function uploadWithRetry(
    deps: BatchUploadDeps,
    folderPath: string,
    filename: string,
    buffer: Buffer,
    retryCount: number,
    secrets: Array<string | undefined>
): Promise<{ fileId: string }> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        try {
            return await deps.uploadFile(folderPath, filename, buffer);
        } catch (error) {
            lastError = error;
            if (!(error instanceof TransientUploadError) || attempt === retryCount) {
                throw error;
            }
            deps.log(`Falha transitória ao enviar "${filename}" (${describeUploadError(error, secrets)}); tentando de novo...`);
        }
    }

    throw lastError;
}

function summarize(results: BatchFileResult[]): BatchUploadSummary {
    return {
        results,
        sentCount: results.filter((r) => r.status === "enviado").length,
        skippedCount: results.filter((r) => r.status === "pulado").length,
        errorCount: results.filter((r) => r.status === "erro").length,
        readyCount: results.filter((r) => r.status === "pronto_para_envio").length,
        warningCount: results.filter((r) => r.warnings.length > 0).length
    };
}

export interface RegisterLegacyDeps {
    listPdfFilenames: (folderPath: string) => Promise<string[]>;
    readFileBuffer: (folderPath: string, filename: string) => Promise<Buffer>;
    readManifest: () => Promise<Manifest>;
    writeManifest: (manifest: Manifest) => Promise<void>;
    now: () => Date;
    log: (line: string) => void;
}

export type RegisterLegacyStatus = "registrado" | "ja_registrado" | "erro";

export interface RegisterLegacyResult {
    filename: string;
    sourceName?: string;
    status: RegisterLegacyStatus;
    error?: string;
}

export interface RegisterLegacySummary {
    results: RegisterLegacyResult[];
    registeredCount: number;
    alreadyRegisteredCount: number;
    errorCount: number;
}

/**
 * Registra, SEM chamar a OpenAI, os PDFs de `folderPath` que ainda não estão no manifesto —
 * para bulas enviadas antes de o manifesto existir ("legado"). Não aplica a validação estrita
 * de nome (aceita nomes antigos, como os com acento ou "+"): só precisa ser um PDF de verdade.
 * Reexecutar é idempotente — arquivo (por nome ou pelo mesmo SHA-256) já no manifesto é pulado.
 */
export async function registerExistingBulas(
    folderPath: string,
    deps: RegisterLegacyDeps
): Promise<RegisterLegacySummary> {
    const filenames = [...await deps.listPdfFilenames(folderPath)].sort();
    const manifest = await deps.readManifest();
    const liveManifest: Manifest = [...manifest];
    const results: RegisterLegacyResult[] = [];

    for (const filename of filenames) {
        const sourceName = toReadableSourceName(filename);

        const existingByFilename = findManifestEntryByFilename(liveManifest, filename);
        if (existingByFilename) {
            results.push({ filename, sourceName, status: "ja_registrado" });
            continue;
        }

        let buffer: Buffer;
        try {
            buffer = await deps.readFileBuffer(folderPath, filename);
        } catch (error) {
            results.push({ filename, sourceName, status: "erro", error: describeUploadError(error) });
            continue;
        }

        if (!hasValidPdfHeader(buffer)) {
            results.push({
                filename,
                sourceName,
                status: "erro",
                error: `Não parece ser um PDF válido (não começa com "${PDF_MAGIC_BYTES}").`
            });
            continue;
        }

        const sha256 = computeSha256(buffer);
        const existingByHash = findManifestEntryBySha256(liveManifest, sha256);
        if (existingByHash) {
            results.push({ filename, sourceName, status: "ja_registrado" });
            continue;
        }

        liveManifest.push({ filename, sha256, uploadedAt: deps.now().toISOString(), origin: "legado" });
        await deps.writeManifest(liveManifest);
        results.push({ filename, sourceName, status: "registrado" });
        deps.log(`REGISTRADO: "${filename}" (Fonte: "${sourceName}").`);
    }

    return {
        results,
        registeredCount: results.filter((r) => r.status === "registrado").length,
        alreadyRegisteredCount: results.filter((r) => r.status === "ja_registrado").length,
        errorCount: results.filter((r) => r.status === "erro").length
    };
}
