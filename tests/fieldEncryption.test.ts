import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const TEST_KEY = randomBytes(32).toString("base64");
process.env.MEDICATION_ENCRYPTION_KEY = TEST_KEY;

const {
    decryptField,
    decryptOptionalField,
    encryptField,
    encryptOptionalField,
    isEncrypted,
    isEncryptionConfigured
} = await import("../src/services/fieldEncryption.ts");
const { encryptLegacyMedications } = await import("../src/services/medicationService.ts");

test("cifra e decifra o nome do medicamento", () => {
    const stored = encryptField("medications.name", "Rozecor 10 mg");
    assert.ok(isEncrypted(stored));
    assert.doesNotMatch(stored, /Rozecor/);
    assert.equal(decryptField("medications.name", stored), "Rozecor 10 mg");
});

test("o mesmo nome gera valores diferentes a cada gravação (IV aleatório)", () => {
    const a = encryptField("medications.name", "Dipirona");
    const b = encryptField("medications.name", "Dipirona");
    assert.notEqual(a, b);
});

test("acentos e emojis sobrevivem à cifragem", () => {
    const value = "Ácido acetilsalicílico 💊";
    assert.equal(decryptField("medications.name", encryptField("medications.name", value)), value);
});

test("texto puro legado é devolvido como está", () => {
    assert.equal(decryptField("medications.name", "Losartana"), "Losartana");
});

test("valor cifrado de outra coluna não decifra", () => {
    const dosage = encryptField("medications.dosage", "500 mg");
    assert.throws(() => decryptField("medications.name", dosage));
});

test("valor adulterado no banco é rejeitado", () => {
    const stored = encryptField("medications.name", "Dipirona");
    const payload = Buffer.from(stored.slice("enc:v1:".length), "base64");
    payload[payload.length - 1] ^= 0xff;
    assert.throws(() => decryptField("medications.name", "enc:v1:" + payload.toString("base64")));
});

test("chave diferente não decifra", () => {
    const stored = encryptField("medications.name", "Dipirona");
    process.env.MEDICATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    try {
        assert.throws(() => decryptField("medications.name", stored));
    } finally {
        process.env.MEDICATION_ENCRYPTION_KEY = TEST_KEY;
    }
});

test("sem chave configurada, gravar falha em vez de salvar texto puro", () => {
    delete process.env.MEDICATION_ENCRYPTION_KEY;
    try {
        assert.equal(isEncryptionConfigured(), false);
        assert.throws(() => encryptField("medications.name", "Dipirona"), /MEDICATION_ENCRYPTION_KEY/);
    } finally {
        process.env.MEDICATION_ENCRYPTION_KEY = TEST_KEY;
    }
});

test("chave com tamanho errado é recusada", () => {
    process.env.MEDICATION_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    try {
        assert.equal(isEncryptionConfigured(), false);
    } finally {
        process.env.MEDICATION_ENCRYPTION_KEY = TEST_KEY;
    }
});

test("campos opcionais nulos continuam nulos", () => {
    assert.equal(encryptOptionalField("medications.dosage", null), null);
    assert.equal(encryptOptionalField("medications.dosage", undefined), null);
    assert.equal(decryptOptionalField("medications.dosage", null), null);
});

test("migração cifra só o que ainda está em texto puro e não sobrescreve edição concorrente", async () => {
    const alreadyEncrypted = encryptField("medications.name", "Losartana");
    const rows = [
        { id: "1", name: "Dipirona", dosage: "500 mg", instructions: null },
        { id: "2", name: alreadyEncrypted, dosage: "1 comprimido", instructions: "Após o almoço" }
    ];
    const updates: unknown[][] = [];
    const pool = {
        async query<T>(text: string, params: unknown[] = []) {
            if (text.trim().startsWith("SELECT")) {
                return { rows: rows as T[], rowCount: rows.length };
            }
            updates.push(params);
            // Simula o registro 2 editado pelo usuário entre a leitura e o UPDATE.
            return { rows: [] as T[], rowCount: params[3] === "2" ? 0 : 1 };
        }
    };

    const count = await encryptLegacyMedications(pool, 50);

    assert.equal(count, 1);
    assert.equal(updates.length, 2);
    const [name1, dosage1, instructions1] = updates[0];
    assert.equal(decryptField("medications.name", name1 as string), "Dipirona");
    assert.equal(decryptField("medications.dosage", dosage1 as string), "500 mg");
    assert.equal(instructions1, null);
    const [name2, dosage2, instructions2] = updates[1];
    assert.equal(name2, alreadyEncrypted);
    assert.equal(decryptField("medications.dosage", dosage2 as string), "1 comprimido");
    assert.equal(decryptField("medications.instructions", instructions2 as string), "Após o almoço");
    // A condição do UPDATE usa os valores lidos, para não sobrescrever edição concorrente.
    assert.deepEqual(updates[0].slice(4), ["Dipirona", "500 mg", null]);
});

test("despachante de lembretes decifra o nome antes de montar a mensagem", async () => {
    const { fetchTelegramDispatchCandidates } = await import("../src/services/reminderDispatchService.ts");
    const pool = {
        async query<T>() {
            return {
                rows: [{
                    reminder_id: "7",
                    medication_name: encryptField("medications.name", "Rozecor"),
                    active: true,
                    starts_on: "2026-11-01",
                    ends_on: null,
                    times: ["08:00"],
                    weekdays: [0, 1, 2, 3, 4, 5, 6],
                    chat_id: "123",
                    email: null,
                    email_verified_at: null
                }] as T[],
                rowCount: 1
            };
        }
    };
    const [candidate] = await fetchTelegramDispatchCandidates(pool as never);
    assert.equal(candidate.medicationName, "Rozecor");
});
