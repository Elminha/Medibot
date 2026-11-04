import fs from "node:fs";
import path from "node:path";
import { parseManifest, type Manifest } from "./bulaUploadService.js";
import { toReadableSourceName } from "./bulaSourceName.js";

const MANIFEST_PATH = path.resolve("bulas", "uploaded.json");

/** Nomes legíveis e únicos das bulas do manifesto, em ordem alfabética (pt-BR). */
export function toAvailableBulaNames(manifest: Manifest): string[] {
    const names = new Set(manifest.map((entry) => toReadableSourceName(entry.filename)));
    return [...names].sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
}

export async function listAvailableBulas(): Promise<string[]> {
    let raw: string;
    try {
        raw = await fs.promises.readFile(MANIFEST_PATH, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw error;
    }

    return toAvailableBulaNames(parseManifest(raw));
}
