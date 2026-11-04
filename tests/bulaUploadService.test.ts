import test from "node:test";
import assert from "node:assert/strict";
import {
    computeSha256,
    describeUploadError,
    hasValidPdfHeader,
    isTransientOpenAiError,
    isValidBulaFilename,
    isValidBulaFileSize,
    ManifestParseError,
    MIN_BULA_FILE_SIZE_BYTES,
    parseManifest,
    redactSecrets,
    registerExistingBulas,
    runBatchUpload,
    serializeManifest,
    TransientUploadError,
    type BatchUploadDeps,
    type Manifest,
    type ManifestEntry
} from "../src/services/bulaUploadService.ts";

function makeValidPdfBuffer(size = MIN_BULA_FILE_SIZE_BYTES + 1024, fillByte = 0x41): Buffer {
    const header = Buffer.from("%PDF-1.4\n");
    const padding = Buffer.alloc(Math.max(0, size - header.length), fillByte);
    return Buffer.concat([header, padding]);
}

type UploadBehavior = "ok" | "transient-once" | "fail";

function makeFakeDeps(options: {
    files?: Record<string, Buffer>;
    manifest?: Manifest;
    uploadBehavior?: Record<string, UploadBehavior>;
} = {}) {
    const files = new Map(Object.entries(options.files ?? {}));
    let manifest: Manifest = options.manifest ? options.manifest.map((entry) => ({ ...entry })) : [];
    const writeManifestCalls: Manifest[] = [];
    const uploadCalls: string[] = [];
    const readFileBufferCalls: string[] = [];
    const logLines: string[] = [];
    const sleepCalls: number[] = [];
    const transientAttempts = new Map<string, number>();
    let fileIdCounter = 0;

    const deps: BatchUploadDeps = {
        async listPdfFilenames() {
            return [...files.keys()];
        },
        async readFileBuffer(_folder, filename) {
            readFileBufferCalls.push(filename);
            const buffer = files.get(filename);
            if (!buffer) throw new Error(`arquivo não encontrado: ${filename}`);
            return buffer;
        },
        async readManifest() {
            return manifest;
        },
        async writeManifest(next) {
            manifest = next;
            writeManifestCalls.push(next.map((entry) => ({ ...entry })));
        },
        async uploadFile(_folder, filename) {
            uploadCalls.push(filename);
            const behavior = options.uploadBehavior?.[filename] ?? "ok";

            if (behavior === "fail") {
                throw new Error(`falha permanente ao enviar ${filename}`);
            }

            if (behavior === "transient-once") {
                const attempts = (transientAttempts.get(filename) ?? 0) + 1;
                transientAttempts.set(filename, attempts);
                if (attempts === 1) {
                    throw new TransientUploadError(`instabilidade simulada em ${filename}`);
                }
            }

            fileIdCounter += 1;
            return { fileId: `file-${fileIdCounter}` };
        },
        async sleep(ms) {
            sleepCalls.push(ms);
        },
        now: () => new Date("2024-01-01T00:00:00.000Z"),
        log: (line) => logLines.push(line)
    };

    return {
        deps,
        getManifest: () => manifest,
        writeManifestCalls,
        uploadCalls,
        readFileBufferCalls,
        logLines,
        sleepCalls
    };
}

function findResult(summary: { results: Array<{ filename: string }> }, filename: string) {
    return summary.results.find((r) => r.filename === filename);
}

// ===== Funções puras =====

test("isValidBulaFilename exige o padrão bula_<nome>.pdf minúsculo, sem acento/espaço/caractere especial", () => {
    assert.equal(isValidBulaFilename("bula_ibuprofeno.pdf"), true);
    assert.equal(isValidBulaFilename("bula_dipirona-sodica_500mg.pdf"), true);
    assert.equal(isValidBulaFilename("Bula_Ibuprofeno.pdf"), false);
    assert.equal(isValidBulaFilename("bula_ibuprofeno.PDF"), false);
    assert.equal(isValidBulaFilename("bula ibuprofeno.pdf"), false);
    assert.equal(isValidBulaFilename("bula_ibuprofeno.pdf "), false);
    assert.equal(isValidBulaFilename("ibuprofeno.pdf"), false);
    assert.equal(isValidBulaFilename("bula_losartana_potássica.pdf"), false);
    assert.equal(isValidBulaFilename("bula_simeticona_+_homatropina.pdf"), false);
});

test("hasValidPdfHeader exige a assinatura %PDF- no início do arquivo", () => {
    assert.equal(hasValidPdfHeader(makeValidPdfBuffer()), true);
    assert.equal(hasValidPdfHeader(Buffer.from("não é um pdf, só texto")), false);
});

test("isValidBulaFileSize respeita o mínimo e o máximo", () => {
    assert.equal(isValidBulaFileSize(MIN_BULA_FILE_SIZE_BYTES), true);
    assert.equal(isValidBulaFileSize(MIN_BULA_FILE_SIZE_BYTES - 1), false);
    assert.equal(isValidBulaFileSize(20 * 1024 * 1024), true);
    assert.equal(isValidBulaFileSize(20 * 1024 * 1024 + 1), false);
});

test("computeSha256 é determinístico e sensível ao conteúdo", () => {
    const a = computeSha256(Buffer.from("conteudo"));
    const b = computeSha256(Buffer.from("conteudo"));
    const c = computeSha256(Buffer.from("outro"));
    assert.equal(a, b);
    assert.notEqual(a, c);
});

test("redactSecrets troca o segredo por [REDACTED] em qualquer posição da mensagem", () => {
    const secret = "sk-segredo-super-real-123456";
    assert.equal(
        redactSecrets(`Unauthorized: chave ${secret} inválida`, [secret]),
        "Unauthorized: chave [REDACTED] inválida"
    );
    assert.equal(redactSecrets("mensagem sem segredo", [secret]), "mensagem sem segredo");
    assert.equal(redactSecrets("mensagem qualquer", [undefined]), "mensagem qualquer");
});

test("describeUploadError nunca deixa a chave passar e nunca inclui stack trace", () => {
    const secret = "sk-chave-secreta-de-teste";
    const error = new Error(`Request failed with key ${secret}`);
    const message = describeUploadError(error, [secret]);
    assert.doesNotMatch(message, new RegExp(secret));
    assert.doesNotMatch(message, /at .*\(.*:\d+:\d+\)/); // formato típico de linha de stack trace
    assert.equal(describeUploadError("não é um Error"), "Erro desconhecido ao enviar o arquivo.");
});

test("isTransientOpenAiError reconhece status 5xx/429/408 e erros de rede como transitórios", () => {
    assert.equal(isTransientOpenAiError({ status: 429 }), true);
    assert.equal(isTransientOpenAiError({ status: 503 }), true);
    assert.equal(isTransientOpenAiError({ status: 400 }), false);
    assert.equal(isTransientOpenAiError({ code: "ECONNRESET" }), true);
    assert.equal(isTransientOpenAiError({ code: "EBADF" }), false);
    assert.equal(isTransientOpenAiError(null), false);
    assert.equal(isTransientOpenAiError("string qualquer"), false);
});

test("parseManifest aceita vazio/lista válida e rejeita JSON malformado ou formato inesperado", () => {
    assert.deepEqual(parseManifest(""), []);
    assert.deepEqual(parseManifest("   "), []);

    const entry: ManifestEntry = {
        filename: "bula_x.pdf", sha256: "abc", openaiFileId: "file-1",
        uploadedAt: "2024-01-01T00:00:00.000Z", origin: "upload"
    };
    assert.deepEqual(parseManifest(JSON.stringify([entry])), [entry]);
    // Campos novos (openaiFileId, origin) são opcionais na entrada: entrada legada antiga é aceita.
    assert.deepEqual(
        parseManifest(JSON.stringify([{ filename: "bula_legado.pdf", sha256: "def", uploadedAt: "2023-01-01T00:00:00.000Z" }])),
        [{ filename: "bula_legado.pdf", sha256: "def", uploadedAt: "2023-01-01T00:00:00.000Z", origin: "upload" }]
    );

    assert.throws(() => parseManifest("{ not json"), ManifestParseError);
    assert.throws(() => parseManifest(JSON.stringify({ not: "a list" })), ManifestParseError);
    assert.throws(() => parseManifest(JSON.stringify([{ filename: "x.pdf" }])), ManifestParseError);
});

test("serializeManifest ordena por filename (diff estável) e round-tripa com parseManifest", () => {
    const manifest: Manifest = [
        { filename: "bula_z.pdf", sha256: "2", openaiFileId: "file-2", uploadedAt: "2024-01-02T00:00:00.000Z" },
        { filename: "bula_a.pdf", sha256: "1", openaiFileId: "file-1", uploadedAt: "2024-01-01T00:00:00.000Z" }
    ];
    const serialized = serializeManifest(manifest);
    const roundTripped = parseManifest(serialized);
    assert.deepEqual(roundTripped.map((e) => e.filename), ["bula_a.pdf", "bula_z.pdf"]);
});

// ===== runBatchUpload =====

test("arquivo com nome fora do padrão vira erro, sem ler conteúdo nem tentar enviar", async () => {
    const { deps, readFileBufferCalls, uploadCalls } = makeFakeDeps({
        files: { "Bula_Ibuprofeno.pdf": makeValidPdfBuffer() }
    });

    const summary = await runBatchUpload("bulas", { dryRun: false }, deps);

    assert.equal(summary.errorCount, 1);
    const result = findResult(summary, "Bula_Ibuprofeno.pdf");
    assert.equal(result?.status, "erro");
    assert.match(result?.errors[0] ?? "", /fora do padrão esperado/);
    assert.deepEqual(readFileBufferCalls, []);
    assert.deepEqual(uploadCalls, []);
});

test("PDF inválido (sem a assinatura %PDF-) vira erro e não é enviado", async () => {
    const { deps, uploadCalls } = makeFakeDeps({
        files: { "bula_teste.pdf": Buffer.concat([Buffer.from("não é um pdf"), Buffer.alloc(MIN_BULA_FILE_SIZE_BYTES)]) }
    });

    const summary = await runBatchUpload("bulas", { dryRun: false }, deps);

    assert.equal(summary.errorCount, 1);
    const result = findResult(summary, "bula_teste.pdf");
    assert.equal(result?.status, "erro");
    assert.match(result?.errors.join(" ") ?? "", /não parece ser um PDF válido/i);
    assert.deepEqual(uploadCalls, []);
});

test("PDF menor que o tamanho mínimo vira erro e não é enviado", async () => {
    const { deps, uploadCalls } = makeFakeDeps({
        files: { "bula_pequena.pdf": makeValidPdfBuffer(100) }
    });

    const summary = await runBatchUpload("bulas", { dryRun: false }, deps);

    assert.equal(summary.errorCount, 1);
    const result = findResult(summary, "bula_pequena.pdf");
    assert.match(result?.errors.join(" ") ?? "", /Tamanho fora do esperado/);
    assert.deepEqual(uploadCalls, []);
});

test("duplicado por hash contra o manifesto: mesmo conteúdo já enviado com outro nome", async () => {
    const buffer = makeValidPdfBuffer();
    const { deps, uploadCalls } = makeFakeDeps({
        files: { "bula_ibuprofeno_novo.pdf": buffer },
        manifest: [{
            filename: "bula_ibuprofeno.pdf",
            sha256: computeSha256(buffer),
            openaiFileId: "file-antigo",
            uploadedAt: "2023-01-01T00:00:00.000Z",
            origin: "upload"
        }]
    });

    const summary = await runBatchUpload("bulas", { dryRun: false }, deps);

    assert.equal(summary.errorCount, 1);
    const result = findResult(summary, "bula_ibuprofeno_novo.pdf");
    assert.match(result?.errors.join(" ") ?? "", /já enviado anteriormente como "bula_ibuprofeno\.pdf"/);
    assert.deepEqual(uploadCalls, []);
});

test("duplicado por hash dentro do próprio lote: dois arquivos novos com o mesmo conteúdo", async () => {
    const buffer = makeValidPdfBuffer();
    const { deps, uploadCalls } = makeFakeDeps({
        files: {
            "bula_a.pdf": buffer,
            "bula_b.pdf": Buffer.from(buffer) // mesmo conteúdo, cópia
        }
    });

    const summary = await runBatchUpload("bulas", { dryRun: false }, deps);

    assert.equal(summary.errorCount, 2);
    for (const filename of ["bula_a.pdf", "bula_b.pdf"]) {
        const result = findResult(summary, filename);
        assert.equal(result?.status, "erro");
        assert.match(result?.errors.join(" ") ?? "", /Mesmo conteúdo \(SHA-256\) que outro arquivo deste lote/);
    }
    assert.deepEqual(uploadCalls, []);
});

test("Fonte repetida: dois nomes diferentes (_ vs - no corpo do nome) que convergem para a mesma Fonte são rejeitados", async () => {
    const { deps, uploadCalls } = makeFakeDeps({
        files: {
            "bula_dipirona_sodica.pdf": makeValidPdfBuffer(MIN_BULA_FILE_SIZE_BYTES + 100, 0x41),
            "bula_dipirona-sodica.pdf": makeValidPdfBuffer(MIN_BULA_FILE_SIZE_BYTES + 200, 0x42)
        }
    });

    const summary = await runBatchUpload("bulas", { dryRun: false }, deps);

    assert.equal(summary.errorCount, 2);
    for (const filename of ["bula_dipirona_sodica.pdf", "bula_dipirona-sodica.pdf"]) {
        const result = findResult(summary, filename);
        assert.equal(result?.sourceName, "Dipirona Sodica");
        assert.equal(result?.status, "erro");
        assert.match(result?.errors.join(" ") ?? "", /gerariam a mesma Fonte \("Dipirona Sodica"\)/);
    }
    assert.deepEqual(uploadCalls, []);
});

test("arquivo já presente no manifesto (mesmo nome) é pulado, sem ler o conteúdo nem tentar enviar", async () => {
    const { deps, readFileBufferCalls, uploadCalls } = makeFakeDeps({
        files: { "bula_ibuprofeno.pdf": makeValidPdfBuffer() },
        manifest: [{
            filename: "bula_ibuprofeno.pdf",
            sha256: "qualquer-coisa-já-registrada",
            openaiFileId: "file-antigo",
            uploadedAt: "2023-01-01T00:00:00.000Z",
            origin: "upload"
        }]
    });

    const summary = await runBatchUpload("bulas", { dryRun: false }, deps);

    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.sentCount, 0);
    assert.equal(summary.errorCount, 0);
    assert.equal(findResult(summary, "bula_ibuprofeno.pdf")?.status, "pulado");
    assert.deepEqual(readFileBufferCalls, []);
    assert.deepEqual(uploadCalls, []);
});

test("--dry-run nunca chama uploadFile nem grava o manifesto, mesmo com arquivos válidos prontos para envio", async () => {
    const { deps, uploadCalls, writeManifestCalls } = makeFakeDeps({
        files: { "bula_ibuprofeno.pdf": makeValidPdfBuffer() }
    });
    // Garante que uploadFile explode se for chamado por engano.
    deps.uploadFile = async () => {
        throw new Error("uploadFile não deveria ser chamado em --dry-run");
    };

    const summary = await runBatchUpload("bulas", { dryRun: true }, deps);

    assert.equal(summary.sentCount, 0);
    assert.equal(summary.readyCount, 1);
    assert.equal(findResult(summary, "bula_ibuprofeno.pdf")?.status, "pronto_para_envio");
    assert.deepEqual(uploadCalls, []);
    assert.deepEqual(writeManifestCalls, []);
});

test("falha no meio do lote: grava o manifesto a cada sucesso e continua com os demais após um erro", async () => {
    const bufferA = makeValidPdfBuffer(MIN_BULA_FILE_SIZE_BYTES + 10, 0x41);
    const bufferB = makeValidPdfBuffer(MIN_BULA_FILE_SIZE_BYTES + 20, 0x42);
    const bufferC = makeValidPdfBuffer(MIN_BULA_FILE_SIZE_BYTES + 30, 0x43);

    const { deps, getManifest, writeManifestCalls, sleepCalls } = makeFakeDeps({
        files: { "bula_a.pdf": bufferA, "bula_b.pdf": bufferB, "bula_c.pdf": bufferC },
        uploadBehavior: { "bula_b.pdf": "fail" }
    });

    const summary = await runBatchUpload("bulas", { dryRun: false, delayMs: 5 }, deps);

    assert.equal(summary.sentCount, 2);
    assert.equal(summary.errorCount, 1);
    assert.equal(findResult(summary, "bula_a.pdf")?.status, "enviado");
    assert.equal(findResult(summary, "bula_b.pdf")?.status, "erro");
    assert.equal(findResult(summary, "bula_c.pdf")?.status, "enviado");
    assert.doesNotMatch(findResult(summary, "bula_b.pdf")?.errors.join(" ") ?? "", /at .*:\d+:\d+/);

    // Manifesto gravado só nos 2 sucessos (não na falha), preservando o progresso parcial.
    assert.equal(writeManifestCalls.length, 2);
    assert.deepEqual(writeManifestCalls[0].map((e) => e.filename), ["bula_a.pdf"]);
    assert.deepEqual(writeManifestCalls[1].map((e) => e.filename).sort(), ["bula_a.pdf", "bula_c.pdf"]);
    assert.deepEqual(getManifest().map((e) => e.filename).sort(), ["bula_a.pdf", "bula_c.pdf"]);

    // Intervalo entre arquivos: 2 pausas para 3 arquivos (nenhuma antes do primeiro).
    assert.deepEqual(sleepCalls, [5, 5]);
});

test("erro transitório é tentado de novo uma vez e tem sucesso; erro permanente não é tentado de novo", async () => {
    const bufferOk = makeValidPdfBuffer(MIN_BULA_FILE_SIZE_BYTES + 10, 0x41);
    const bufferFail = makeValidPdfBuffer(MIN_BULA_FILE_SIZE_BYTES + 20, 0x42);

    const { deps, uploadCalls } = makeFakeDeps({
        files: { "bula_instavel.pdf": bufferOk, "bula_quebrada.pdf": bufferFail },
        uploadBehavior: { "bula_instavel.pdf": "transient-once", "bula_quebrada.pdf": "fail" }
    });

    const summary = await runBatchUpload("bulas", { dryRun: false, delayMs: 0 }, deps);

    assert.equal(findResult(summary, "bula_instavel.pdf")?.status, "enviado");
    assert.equal(findResult(summary, "bula_quebrada.pdf")?.status, "erro");
    assert.equal(uploadCalls.filter((f) => f === "bula_instavel.pdf").length, 2);
    assert.equal(uploadCalls.filter((f) => f === "bula_quebrada.pdf").length, 1);
});

// ===== registerExistingBulas (bulas legadas, enviadas antes do manifesto existir) =====

test("registra bulas legadas sem chamar a OpenAI, mesmo com nome fora do padrão estrito", async () => {
    const buffer = makeValidPdfBuffer();
    const { deps, uploadCalls, getManifest } = makeFakeDeps({
        files: { "bula_simeticona_+_homatropina.pdf": buffer }
    });

    const summary = await registerExistingBulas("bulas", deps);

    assert.equal(summary.registeredCount, 1);
    assert.equal(summary.alreadyRegisteredCount, 0);
    assert.equal(summary.errorCount, 0);
    assert.deepEqual(uploadCalls, []); // nunca chama deps.uploadFile (nem existe no tipo RegisterLegacyDeps)

    const manifest = getManifest();
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].filename, "bula_simeticona_+_homatropina.pdf");
    assert.equal(manifest[0].sha256, computeSha256(buffer));
    assert.equal(manifest[0].origin, "legado");
    assert.equal(manifest[0].openaiFileId, undefined);
});

test("registrar legados é idempotente: reexecutar não duplica entradas", async () => {
    const buffer = makeValidPdfBuffer();
    const { deps, getManifest } = makeFakeDeps({
        files: { "bula_antiga.pdf": buffer }
    });

    const first = await registerExistingBulas("bulas", deps);
    assert.equal(first.registeredCount, 1);

    const second = await registerExistingBulas("bulas", deps);
    assert.equal(second.registeredCount, 0);
    assert.equal(second.alreadyRegisteredCount, 1);

    assert.equal(getManifest().length, 1);
});

test("lote normal pula bulas já registradas como legado, sem ler o conteúdo", async () => {
    const { deps, readFileBufferCalls, uploadCalls } = makeFakeDeps({
        files: { "bula_simeticona_+_homatropina.pdf": makeValidPdfBuffer() },
        manifest: [{
            filename: "bula_simeticona_+_homatropina.pdf",
            sha256: "qualquer-hash-já-registrado",
            uploadedAt: "2023-01-01T00:00:00.000Z",
            origin: "legado"
        }]
    });

    const summary = await runBatchUpload("bulas", { dryRun: false }, deps);

    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.sentCount, 0);
    assert.equal(findResult(summary, "bula_simeticona_+_homatropina.pdf")?.status, "pulado");
    assert.deepEqual(readFileBufferCalls, []);
    assert.deepEqual(uploadCalls, []);
});

// ===== Aviso (não bloqueante) de Fonte repetida contra o manifesto =====

test("Fonte já existente no manifesto (legado) gera aviso, não erro, em --dry-run", async () => {
    const { deps } = makeFakeDeps({
        files: { "bula__dipirona.pdf": makeValidPdfBuffer() },
        manifest: [{
            filename: "bula_dipirona.pdf",
            sha256: "hash-completamente-diferente",
            uploadedAt: "2023-01-01T00:00:00.000Z",
            origin: "legado"
        }]
    });

    const summary = await runBatchUpload("bulas", { dryRun: true }, deps);

    const result = findResult(summary, "bula__dipirona.pdf");
    assert.equal(result?.sourceName, "Dipirona");
    assert.equal(result?.status, "pronto_para_envio"); // aviso não bloqueia
    assert.equal(result?.errors.length, 0);
    assert.equal(result?.warnings.length, 1);
    assert.match(result?.warnings[0] ?? "", /já existe uma bula com a Fonte "Dipirona"/i);
    assert.match(result?.warnings[0] ?? "", /bula_dipirona\.pdf/);
    assert.equal(summary.warningCount, 1);
    assert.equal(summary.errorCount, 0);
});

test("Fonte já existente no manifesto (upload) gera aviso mas não bloqueia o envio real", async () => {
    const { deps, uploadCalls } = makeFakeDeps({
        files: { "bula__dipirona.pdf": makeValidPdfBuffer() },
        manifest: [{
            filename: "bula_dipirona.pdf",
            sha256: "hash-completamente-diferente",
            uploadedAt: "2023-01-01T00:00:00.000Z",
            origin: "upload",
            openaiFileId: "file-antigo"
        }]
    });

    const summary = await runBatchUpload("bulas", { dryRun: false }, deps);

    const result = findResult(summary, "bula__dipirona.pdf");
    assert.equal(result?.status, "enviado");
    assert.equal(result?.warnings.length, 1);
    assert.equal(summary.sentCount, 1);
    assert.equal(summary.warningCount, 1);
    assert.deepEqual(uploadCalls, ["bula__dipirona.pdf"]);
});
