import test from "node:test";
import assert from "node:assert/strict";

const {
    DEFAULT_MAX_ATTEMPTS,
    buildReminderMessage,
    runReminderDispatch,
    summarizeDispatchError
} = await import("../src/services/reminderDispatchService.ts");

interface CandidateRow {
    reminder_id: string;
    medication_name: string;
    active: boolean;
    starts_on: string;
    ends_on: string | null;
    times: string[];
    weekdays: number[];
    chat_id: string | null;
    email: string | null;
    email_verified_at: Date | null;
}

function candidateRow(options: {
    id: number;
    medicationName?: string;
    active?: boolean;
    times: string[];
    weekdays?: number[];
    startsOn?: string | null;
    endsOn?: string | null;
    chatId?: number | null;
    emailVerified?: boolean;
}): CandidateRow {
    return {
        reminder_id: String(options.id),
        medication_name: options.medicationName ?? "Dipirona",
        active: options.active ?? true,
        starts_on: options.startsOn ?? "2024-01-01",
        ends_on: options.endsOn ?? null,
        times: options.times,
        weekdays: options.weekdays ?? [],
        chat_id: options.chatId === undefined ? null : (options.chatId === null ? null : String(options.chatId)),
        email: "usuario@exemplo.com",
        email_verified_at: (options.emailVerified ?? true) ? new Date() : null
    };
}

interface FakeDeliveryRow {
    id: number;
    status: "pending" | "sending" | "sent" | "failed" | "skipped";
    attempts: number;
    error: string | null;
    updatedAtMs: number;
}

/**
 * Pool em memória que reproduz a semântica exata das queries de
 * reminderDispatchService.ts (reivindicação atômica via INSERT ... ON CONFLICT ...,
 * UPDATE de status), sem Postgres de verdade. `clock` é a MESMA referência passada
 * como `now` nas deps do despachante, para CURRENT_TIMESTAMP (aqui) e "agora" (lá)
 * nunca divergirem nos testes.
 */
function createFakePool(clock: { now: () => Date }) {
    let candidates: CandidateRow[] = [];
    const deliveries = new Map<string, FakeDeliveryRow>();
    let nextId = 1;
    const insertCalls: unknown[][] = [];

    function keyFor(reminderId: number, occurrenceAt: Date): string {
        return `${reminderId}:telegram:${occurrenceAt.getTime()}`;
    }

    async function query(text: string, params: unknown[] = []) {
        const sql = text.trim();

        if (sql.includes("INNER JOIN reminder_channels")) {
            return { rows: candidates, rowCount: candidates.length };
        }

        if (sql.startsWith("INSERT INTO reminder_deliveries") && sql.includes("'skipped'")) {
            insertCalls.push(params);
            const [reminderId, occurrenceAt] = params as [number, Date];
            const key = keyFor(reminderId, occurrenceAt);
            if (deliveries.has(key)) {
                return { rows: [], rowCount: 0 };
            }
            const id = nextId++;
            deliveries.set(key, { id, status: "skipped", attempts: 0, error: null, updatedAtMs: clock.now().getTime() });
            return { rows: [{ id: String(id) }], rowCount: 1 };
        }

        if (sql.startsWith("INSERT INTO reminder_deliveries") && sql.includes("'sending'")) {
            insertCalls.push(params);
            const [reminderId, occurrenceAt, stuckAfterMs] = params as [number, Date, number];
            const key = keyFor(reminderId, occurrenceAt);
            const nowMs = clock.now().getTime();
            const existing = deliveries.get(key);

            if (!existing) {
                const id = nextId++;
                deliveries.set(key, { id, status: "sending", attempts: 1, error: null, updatedAtMs: nowMs });
                return { rows: [{ id: String(id), attempts: 1 }], rowCount: 1 };
            }

            const canReclaim = existing.status === "pending"
                || (existing.status === "sending" && existing.updatedAtMs < nowMs - stuckAfterMs);

            if (!canReclaim) {
                return { rows: [], rowCount: 0 };
            }

            existing.status = "sending";
            existing.attempts += 1;
            existing.updatedAtMs = nowMs;
            return { rows: [{ id: String(existing.id), attempts: existing.attempts }], rowCount: 1 };
        }

        if (sql.startsWith("UPDATE reminder_deliveries")) {
            const [id] = params as [number];
            const entry = [...deliveries.values()].find((d) => d.id === id);
            if (entry) {
                if (sql.includes("'sent'")) {
                    entry.status = "sent";
                    entry.error = null;
                } else if (sql.includes("'pending'")) {
                    entry.status = "pending";
                    entry.error = (params as [number, string])[1];
                } else if (sql.includes("'failed'")) {
                    entry.status = "failed";
                    entry.error = (params as [number, string])[1];
                }
                entry.updatedAtMs = clock.now().getTime();
            }
            return { rows: [], rowCount: entry ? 1 : 0 };
        }

        throw new Error(`fakeQuery não sabe lidar com: ${sql}`);
    }

    return {
        pool: { query },
        setCandidates(rows: CandidateRow[]) { candidates = rows; },
        deliveries,
        insertCalls,
        seedDelivery(reminderId: number, occurrenceAt: Date, row: Omit<FakeDeliveryRow, "id">) {
            deliveries.set(keyFor(reminderId, occurrenceAt), { id: nextId++, ...row });
        }
    };
}

function createFakeSender(behavior: (chatId: number, text: string) => Promise<void> | void) {
    const calls: Array<{ chatId: number; text: string }> = [];
    return {
        calls,
        async sendMessage(chatId: number, text: string) {
            calls.push({ chatId, text });
            await behavior(chatId, text);
        }
    };
}

// 08:00 local em America/Sao_Paulo (fuso fixo, sem horário de verão) = 11:00 UTC.
const OCCURRENCE_LOCAL_0800 = new Date("2024-01-10T11:00:00.000Z");

test("buildReminderMessage: texto puro, sem markdown/HTML, sem dose nem recomendação", () => {
    const message = buildReminderMessage("Dipirona 500mg *importante* <script>", "08:00");
    assert.equal(message, "💊 Hora do medicamento: Dipirona 500mg *importante* <script> (08:00)");
    assert.doesNotMatch(message, /dose|mg\/kg|recomend/i);
});

test("buildReminderMessage preserva caracteres especiais do nome do medicamento sem escapar", () => {
    const name = "Remédio* _teste_ <tag> [nota]";
    const message = buildReminderMessage(name, "08:00");
    assert.ok(message.includes(name));
});

test("summarizeDispatchError nunca devolve a mensagem completa da exceção", () => {
    assert.equal(summarizeDispatchError({ error_code: 403 }), "blocked");
    assert.equal(summarizeDispatchError({ error_code: 429, parameters: { retry_after: 30 } }), "rate_limited:30");
    assert.equal(summarizeDispatchError({ error_code: 429 }), "rate_limited:unknown");
    assert.equal(summarizeDispatchError(new Error("detalhe técnico sensível do usuário X")), "send_failed");
});

test("ocorrência dentro da janela é enviada; candidatos/ocorrências contados corretamente", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime() + 2 * 60_000) };
    const { pool, setCandidates } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555 })]);
    const sender = createFakeSender(() => {});

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });

    assert.equal(summary.candidates, 1);
    assert.equal(summary.occurrencesInWindow, 1);
    assert.equal(summary.sent, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.failed, 0);
    assert.equal(sender.calls.length, 1);
    assert.equal(sender.calls[0].chatId, 555);
    assert.match(sender.calls[0].text, /Dipirona/);
});

test("ocorrência exatamente no limite 'agora' é enviada; exatamente no limite 'agora - 5min' não", async () => {
    const atNow = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const atLowerBound = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime() + 5 * 60_000) };

    {
        const { pool, setCandidates } = createFakePool(atNow);
        setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555 })]);
        const sender = createFakeSender(() => {});
        const summary = await runReminderDispatch({ pool, sender, now: atNow.now }, { dryRun: false });
        assert.equal(summary.sent, 1);
    }
    {
        const { pool, setCandidates } = createFakePool(atLowerBound);
        setCandidates([candidateRow({ id: 2, times: ["08:00"], chatId: 555 })]);
        const sender = createFakeSender(() => {});
        const summary = await runReminderDispatch({ pool, sender, now: atLowerBound.now }, { dryRun: false });
        assert.equal(summary.sent, 0);
        assert.equal(summary.occurrencesInWindow, 0);
    }
});

test("virada de meia-noite: ocorrência de 'ontem' às 23:58 ainda é enviada minutos depois da virada", async () => {
    // 23:58 local em 2024-01-10 = 2024-01-11T02:58:00.000Z.
    const occurrenceAt = new Date("2024-01-11T02:58:00.000Z");
    const clock = { now: () => new Date(occurrenceAt.getTime() + 4 * 60_000) }; // 00:02 local do dia seguinte
    const { pool, setCandidates } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["23:58"], chatId: 555 })]);
    const sender = createFakeSender(() => {});

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.sent, 1);
});

test("vários lembretes due no mesmo minuto geram um envio cada", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates } = createFakePool(clock);
    setCandidates([
        candidateRow({ id: 1, times: ["08:00"], chatId: 555 }),
        candidateRow({ id: 2, times: ["08:00"], chatId: 556 }),
        candidateRow({ id: 3, times: ["08:00"], chatId: 557 })
    ]);
    const sender = createFakeSender(() => {});

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.sent, 3);
    assert.equal(sender.calls.length, 3);
});

test("lembrete pausado/excluído nunca aparece como candidato (simples ausência da lista)", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates } = createFakePool(clock);
    setCandidates([]); // pausado (active=false) ou excluído: nunca vira linha no SELECT real
    const sender = createFakeSender(() => {});

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.candidates, 0);
    assert.equal(summary.sent, 0);
    assert.equal(sender.calls.length, 0);
});

test("dias da semana: só dispara no dia programado", async () => {
    // 2024-01-10 é quarta-feira (weekday=3).
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const senderA = createFakeSender(() => {});
    {
        const { pool, setCandidates } = createFakePool(clock);
        setCandidates([candidateRow({ id: 1, times: ["08:00"], weekdays: [1], chatId: 555 })]); // só segunda
        const summary = await runReminderDispatch({ pool, sender: senderA, now: clock.now }, { dryRun: false });
        assert.equal(summary.sent, 0);
    }
    const senderB = createFakeSender(() => {});
    {
        const { pool, setCandidates } = createFakePool(clock);
        setCandidates([candidateRow({ id: 2, times: ["08:00"], weekdays: [3], chatId: 555 })]); // quarta
        const summary = await runReminderDispatch({ pool, sender: senderB, now: clock.now }, { dryRun: false });
        assert.equal(summary.sent, 1);
    }
});

test("vigência: fora de startsOn/endsOn não dispara", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["08:00"], startsOn: "2024-02-01", chatId: 555 })]);
    const sender = createFakeSender(() => {});

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.sent, 0);
    assert.equal(summary.occurrencesInWindow, 0);
});

test("usuário sem vínculo do Telegram: registrado como skipped, sem chamar o Telegram", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates, deliveries } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: null })]);
    const sender = createFakeSender(() => {
        throw new Error("não deveria chamar o Telegram para quem não tem vínculo");
    });

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.skipped, 1);
    assert.equal(summary.sent, 0);
    assert.equal(sender.calls.length, 0);
    assert.equal([...deliveries.values()][0].status, "skipped");
});

test("flag EMAIL_VERIFICATION_REQUIRED desligada (padrão): conta vinculada e não verificada ainda recebe o lembrete", async () => {
    delete process.env.EMAIL_VERIFICATION_REQUIRED;
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555, emailVerified: false })]);
    const sender = createFakeSender(() => {});

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.sent, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(sender.calls.length, 1);
});

test("flag EMAIL_VERIFICATION_REQUIRED ligada: conta vinculada mas com e-mail pendente é marcada skipped, sem enviar", async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    try {
        const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
        const { pool, setCandidates, deliveries } = createFakePool(clock);
        setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555, emailVerified: false })]);
        const sender = createFakeSender(() => {
            throw new Error("não deveria chamar o Telegram para conta não verificada");
        });

        const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
        assert.equal(summary.skipped, 1);
        assert.equal(summary.sent, 0);
        assert.equal(sender.calls.length, 0);
        assert.equal([...deliveries.values()][0].status, "skipped");
    } finally {
        delete process.env.EMAIL_VERIFICATION_REQUIRED;
    }
});

test("flag EMAIL_VERIFICATION_REQUIRED ligada: conta JÁ verificada continua recebendo o lembrete normalmente", async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    try {
        const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
        const { pool, setCandidates } = createFakePool(clock);
        setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555, emailVerified: true })]);
        const sender = createFakeSender(() => {});

        const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
        assert.equal(summary.sent, 1);
        assert.equal(summary.skipped, 0);
        assert.equal(sender.calls.length, 1);
    } finally {
        delete process.env.EMAIL_VERIFICATION_REQUIRED;
    }
});

test("flag EMAIL_VERIFICATION_REQUIRED ligada: dryRun também conta como skipped, sem chamar o Telegram", async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    try {
        const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
        const { pool, setCandidates } = createFakePool(clock);
        setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555, emailVerified: false })]);
        const sender = createFakeSender(() => {
            throw new Error("dryRun nunca deveria chamar o Telegram");
        });

        const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: true });
        assert.equal(summary.skipped, 1);
        assert.equal(sender.calls.length, 0);
    } finally {
        delete process.env.EMAIL_VERIFICATION_REQUIRED;
    }
});

test("usuário desvinculado entre execuções: primeira execução envia, segunda (outro horário, já sem vínculo) marca skipped", async () => {
    const firstOccurrence = OCCURRENCE_LOCAL_0800;
    const secondOccurrence = new Date(OCCURRENCE_LOCAL_0800.getTime() + 12 * 60 * 60_000); // 20:00 mesmo dia

    const clock1 = { now: () => new Date(firstOccurrence.getTime()) };
    const { pool, setCandidates } = createFakePool(clock1);
    setCandidates([candidateRow({ id: 1, times: ["08:00", "20:00"], chatId: 555 })]);
    const sender = createFakeSender(() => {});

    const firstSummary = await runReminderDispatch({ pool, sender, now: clock1.now }, { dryRun: false });
    assert.equal(firstSummary.sent, 1);

    // Usuário desvincula o Telegram; nova execução, novo horário, mesmo pool/deliveries.
    setCandidates([candidateRow({ id: 1, times: ["08:00", "20:00"], chatId: null })]);
    const clock2 = { now: () => new Date(secondOccurrence.getTime()) };
    const secondSummary = await runReminderDispatch({ pool, sender, now: clock2.now }, { dryRun: false });

    assert.equal(secondSummary.skipped, 1);
    assert.equal(secondSummary.sent, 0);
    assert.equal(sender.calls.length, 1, "só a primeira execução deve ter chamado o Telegram");
});

test("execução dupla/concorrente do mesmo minuto envia uma única mensagem", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555 })]);
    const sender = createFakeSender(() => {});

    const [a, b] = await Promise.all([
        runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false }),
        runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false })
    ]);

    assert.equal(sender.calls.length, 1);
    assert.equal(a.sent + b.sent, 1);
});

test("entrega travada em 'sending' por mais de 2 min é reivindicada de novo e enviada", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates, seedDelivery } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555 })]);
    seedDelivery(1, OCCURRENCE_LOCAL_0800, {
        status: "sending",
        attempts: 1,
        error: null,
        updatedAtMs: OCCURRENCE_LOCAL_0800.getTime() - 3 * 60_000
    });
    const sender = createFakeSender(() => {});

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.sent, 1);
    assert.equal(sender.calls.length, 1);
});

test("entrega 'sending' há menos de 2 min NÃO é reivindicada (outra execução pode estar em andamento)", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates, seedDelivery } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555 })]);
    seedDelivery(1, OCCURRENCE_LOCAL_0800, {
        status: "sending",
        attempts: 1,
        error: null,
        updatedAtMs: OCCURRENCE_LOCAL_0800.getTime() - 30_000
    });
    const sender = createFakeSender(() => {
        throw new Error("não deveria enviar: outra execução ainda está processando");
    });

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.sent, 0);
    assert.equal(sender.calls.length, 0);
});

test(`${DEFAULT_MAX_ATTEMPTS} tentativas esgotadas marcam failed (sem nova retentativa)`, async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates, seedDelivery, deliveries } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555 })]);
    // Já consumiu 2 tentativas transitórias anteriores (voltou para 'pending' nas duas).
    seedDelivery(1, OCCURRENCE_LOCAL_0800, {
        status: "pending",
        attempts: 2,
        error: "send_failed",
        updatedAtMs: OCCURRENCE_LOCAL_0800.getTime() - 60_000
    });
    const sender = createFakeSender(() => {
        throw new Error("timeout simulado");
    });

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.failed, 1);
    assert.equal(sender.calls.length, 1, "a 3ª tentativa ainda deve tentar enviar");
    const entry = [...deliveries.values()][0];
    assert.equal(entry.status, "failed");
    assert.equal(entry.attempts, 3);
    assert.equal(entry.error, "send_failed");
});

test("entrega já com tentativas esgotadas (travada em 'sending' na última tentativa) falha sem tentar enviar de novo", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates, seedDelivery, deliveries } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555 })]);
    seedDelivery(1, OCCURRENCE_LOCAL_0800, {
        status: "sending",
        attempts: DEFAULT_MAX_ATTEMPTS,
        error: null,
        updatedAtMs: OCCURRENCE_LOCAL_0800.getTime() - 3 * 60_000
    });
    const sender = createFakeSender(() => {
        throw new Error("não deveria tentar enviar: tentativas já esgotadas");
    });

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.failed, 1);
    assert.equal(sender.calls.length, 0);
    assert.equal([...deliveries.values()][0].error, "attempts_exhausted");
});

test("403 (bot bloqueado) marca failed definitivo com erro resumido 'blocked'", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates, deliveries } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555 })]);
    const sender = createFakeSender(() => {
        throw { error_code: 403, description: "Forbidden: bot was blocked by the user" };
    });

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.failed, 1);
    const entry = [...deliveries.values()][0];
    assert.equal(entry.status, "failed");
    assert.equal(entry.error, "blocked");
    assert.equal(entry.attempts, 1, "403 é definitivo: não deve gastar as 3 tentativas");
});

test("429 (rate limit) volta para pending respeitando retry_after, sem contar como falha", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates, deliveries } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, times: ["08:00"], chatId: 555 })]);
    const sender = createFakeSender(() => {
        throw { error_code: 429, parameters: { retry_after: 12 } };
    });

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
    assert.equal(summary.sent, 0);
    assert.equal(summary.failed, 0);
    const entry = [...deliveries.values()][0];
    assert.equal(entry.status, "pending");
    assert.equal(entry.error, "rate_limited:12");
});

test("dryRun: calcula contagens sem enviar e sem gravar em reminder_deliveries", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates, deliveries, insertCalls } = createFakePool(clock);
    setCandidates([
        candidateRow({ id: 1, times: ["08:00"], chatId: 555 }),
        candidateRow({ id: 2, times: ["08:00"], chatId: null })
    ]);
    const sender = createFakeSender(() => {
        throw new Error("dryRun nunca deve chamar o Telegram");
    });

    const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: true });

    assert.equal(summary.candidates, 2);
    assert.equal(summary.occurrencesInWindow, 2);
    assert.equal(summary.sent, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.skipped, 1, "preview: um dos dois não tem vínculo");
    assert.equal(sender.calls.length, 0);
    assert.equal(deliveries.size, 0);
    assert.equal(insertCalls.length, 0);
});

test("ocorrência vencida fora da janela (mais de 5 min de atraso) é contada e registra console.warn, sem dado pessoal", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime() + 8 * 60_000) }; // 8 min de atraso
    const { pool, setCandidates } = createFakePool(clock);
    setCandidates([candidateRow({ id: 1, medicationName: "SegredoDoUsuario", times: ["08:00"], chatId: 555 })]);
    const sender = createFakeSender(() => {});

    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    try {
        const summary = await runReminderDispatch({ pool, sender, now: clock.now }, { dryRun: false });
        assert.equal(summary.expiredOutsideWindow, 1);
        assert.equal(summary.sent, 0);
        assert.equal(warnCalls.length, 1);
        const warnedText = warnCalls[0].map(String).join(" ");
        assert.doesNotMatch(warnedText, /SegredoDoUsuario/);
    } finally {
        console.warn = originalWarn;
    }
});

test("teto de envios por execução: limita quantas mensagens são efetivamente enviadas numa rodada", async () => {
    const clock = { now: () => new Date(OCCURRENCE_LOCAL_0800.getTime()) };
    const { pool, setCandidates } = createFakePool(clock);
    setCandidates([
        candidateRow({ id: 1, times: ["08:00"], chatId: 101 }),
        candidateRow({ id: 2, times: ["08:00"], chatId: 102 }),
        candidateRow({ id: 3, times: ["08:00"], chatId: 103 }),
        candidateRow({ id: 4, times: ["08:00"], chatId: 104 }),
        candidateRow({ id: 5, times: ["08:00"], chatId: 105 })
    ]);
    const sender = createFakeSender(() => {});

    const summary = await runReminderDispatch(
        { pool, sender, now: clock.now, maxSendsPerRun: 2, concurrency: 1 },
        { dryRun: false }
    );

    assert.equal(summary.occurrencesInWindow, 5);
    assert.equal(summary.sent, 2);
    assert.equal(sender.calls.length, 2);
});
