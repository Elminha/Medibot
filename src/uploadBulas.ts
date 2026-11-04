import fs from "node:fs";
import path from "node:path";
import {
    describeUploadError,
    isTransientOpenAiError,
    parseManifest,
    registerExistingBulas,
    runBatchUpload,
    serializeManifest,
    TransientUploadError,
    type BatchUploadDeps,
    type Manifest
} from "./services/bulaUploadService.js";

const MANIFEST_PATH = path.resolve("bulas", "uploaded.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const registerExisting = args.includes("--registrar-existentes");
const folderArg = args.find((arg) => !arg.startsWith("--"));

if (!folderArg) {
    console.error("Uso: npm run upload:bulas -- <pasta> [--dry-run | --registrar-existentes]");
    process.exitCode = 1;
    process.exit();
}

if (dryRun && registerExisting) {
    console.error("Use --dry-run OU --registrar-existentes, não os dois juntos.");
    process.exitCode = 1;
    process.exit();
}

const folderPath = path.resolve(folderArg);

async function listPdfFilenames(folder: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
        throw new Error(`Pasta não encontrada ou sem acesso: ${folder}`);
    }

    return entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
        .map((entry) => entry.name);
}

async function readFileBuffer(folder: string, filename: string): Promise<Buffer> {
    return fs.promises.readFile(path.join(folder, filename));
}

async function readManifest(): Promise<Manifest> {
    let raw: string;
    try {
        raw = await fs.promises.readFile(MANIFEST_PATH, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw error;
    }
    return parseManifest(raw);
}

async function writeManifest(manifest: Manifest): Promise<void> {
    await fs.promises.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
    await fs.promises.writeFile(MANIFEST_PATH, serializeManifest(manifest), "utf8");
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== --registrar-existentes: nunca chama a OpenAI, não precisa de chave =====
if (registerExisting) {
    try {
        const summary = await registerExistingBulas(folderPath, {
            listPdfFilenames,
            readFileBuffer,
            readManifest,
            writeManifest,
            now: () => new Date(),
            log: (line) => console.log(line)
        });

        console.log("Resumo do registro de bulas legadas:");
        console.log(`  Registrados agora: ${summary.registeredCount}`);
        console.log(`  Já estavam no manifesto: ${summary.alreadyRegisteredCount}`);
        console.log(`  Com erro: ${summary.errorCount}`);
        for (const result of summary.results) {
            if (result.status === "erro") {
                console.log(`  ERRO: "${result.filename}" — ${result.error}`);
            }
        }

        process.exitCode = summary.errorCount > 0 ? 1 : 0;
    } catch (error) {
        console.error(`Falha ao registrar bulas legadas: ${describeUploadError(error)}`);
        process.exitCode = 1;
    }
} else {
    // ===== Envio normal (--dry-run ou de verdade) =====
    let uploadFile: BatchUploadDeps["uploadFile"];
    let secrets: Array<string | undefined> = [];

    if (dryRun) {
        // Nunca deveria ser chamado: em --dry-run, runBatchUpload não envia nada.
        uploadFile = async () => {
            throw new Error("uploadFile não deveria ser chamado em --dry-run.");
        };
    } else {
        // Import dinâmico: config.ts lança erro se OPENAI_API_KEY não estiver definida, e isso NÃO
        // pode acontecer em --dry-run (que precisa funcionar sem a chave configurada).
        const { openai, getVectorStoreId } = await import("./config.js");
        const vectorStoreId = getVectorStoreId();
        secrets = [process.env.OPENAI_API_KEY];

        uploadFile = async (folder, filename) => {
            const fullPath = path.join(folder, filename);
            try {
                const vectorStoreFile = await openai.vectorStores.files.uploadAndPoll(
                    vectorStoreId,
                    fs.createReadStream(fullPath)
                );

                if (vectorStoreFile.status !== "completed") {
                    throw new Error(vectorStoreFile.last_error?.message || `status inesperado: ${vectorStoreFile.status}`);
                }

                return { fileId: vectorStoreFile.id };
            } catch (error) {
                if (isTransientOpenAiError(error)) {
                    throw new TransientUploadError(error instanceof Error ? error.message : "Erro transitório.");
                }
                throw error;
            }
        };
    }

    try {
        const summary = await runBatchUpload(
            folderPath,
            { dryRun },
            {
                listPdfFilenames,
                readFileBuffer,
                readManifest,
                writeManifest,
                uploadFile,
                sleep,
                now: () => new Date(),
                log: (line) => console.log(line),
                secrets
            }
        );

        console.log("Resumo:");
        console.log(`  Enviados: ${summary.sentCount}`);
        console.log(`  Pulados (já enviados): ${summary.skippedCount}`);
        console.log(`  Com erro: ${summary.errorCount}`);
        console.log(`  Avisos (Fonte repetida no manifesto): ${summary.warningCount}`);
        if (dryRun) {
            console.log(`  Prontos para envio (dry-run, nada foi enviado): ${summary.readyCount}`);
        }

        process.exitCode = summary.errorCount > 0 ? 1 : 0;
    } catch (error) {
        console.error(`Falha ao processar o lote: ${describeUploadError(error, secrets)}`);
        process.exitCode = 1;
    }
}
