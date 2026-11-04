import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import fs from "node:fs";
import { listAvailableBulas, toAvailableBulaNames } from "../src/services/bulaListService.ts";
import type { Manifest } from "../src/services/bulaUploadService.ts";

test.afterEach(() => {
    mock.restoreAll();
});

test("toAvailableBulaNames converte os nomes de arquivo e ordena alfabeticamente (pt-BR)", () => {
    const manifest: Manifest = [
        { filename: "bula_ibuprofeno.pdf", sha256: "a", uploadedAt: "2026-01-01T00:00:00.000Z", origin: "upload" },
        { filename: "bula_acetilcisteina.pdf", sha256: "b", uploadedAt: "2026-01-01T00:00:00.000Z", origin: "legado" },
        { filename: "bula_azitromicina.pdf", sha256: "c", uploadedAt: "2026-01-01T00:00:00.000Z", origin: "upload" }
    ];

    assert.deepEqual(toAvailableBulaNames(manifest), ["Acetilcisteina", "Azitromicina", "Ibuprofeno"]);
});

test("toAvailableBulaNames remove nomes legíveis duplicados", () => {
    const manifest: Manifest = [
        { filename: "bula_dipirona.pdf", sha256: "a", uploadedAt: "2026-01-01T00:00:00.000Z", origin: "upload" },
        { filename: "Bula - Dipirona.PDF", sha256: "b", uploadedAt: "2026-01-01T00:00:00.000Z", origin: "legado" }
    ];

    assert.deepEqual(toAvailableBulaNames(manifest), ["Dipirona"]);
});

test("toAvailableBulaNames nunca expõe sha256, openaiFileId ou o nome de arquivo cru", () => {
    const manifest: Manifest = [
        {
            filename: "bula_ibuprofeno.pdf",
            sha256: "segredo-hash-123",
            openaiFileId: "file-abc123",
            uploadedAt: "2026-01-01T00:00:00.000Z",
            origin: "upload"
        }
    ];

    const serialized = JSON.stringify(toAvailableBulaNames(manifest));
    assert.doesNotMatch(serialized, /segredo-hash-123|file-abc123|bula_|\.pdf/i);
});

test("listAvailableBulas devolve lista vazia quando o manifesto não existe (ENOENT)", async () => {
    mock.method(fs.promises, "readFile", async () => {
        const error = new Error("not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
    });

    assert.deepEqual(await listAvailableBulas(), []);
});

test("listAvailableBulas lê e converte o manifesto do disco", async () => {
    const manifest: Manifest = [
        { filename: "bula_losartana_potassica.pdf", sha256: "a", uploadedAt: "2026-01-01T00:00:00.000Z", origin: "upload" },
        { filename: "bula_paracetamol.pdf", sha256: "b", uploadedAt: "2026-01-01T00:00:00.000Z", origin: "legado" }
    ];
    mock.method(fs.promises, "readFile", async () => JSON.stringify(manifest));

    assert.deepEqual(await listAvailableBulas(), ["Losartana Potassica", "Paracetamol"]);
});

test("listAvailableBulas propaga erros inesperados (não engole falhas de leitura/parse)", async () => {
    mock.method(fs.promises, "readFile", async () => {
        throw new Error("disco indisponível");
    });

    await assert.rejects(() => listAvailableBulas(), /disco indisponível/);
});
