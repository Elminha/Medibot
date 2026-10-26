// Funções puras do cronômetro do código de vínculo do Telegram (aba Lembretes).
// Isoladas num módulo próprio para serem testáveis sem DOM/timers (tests/telegramLinkCountdown.test.js).

export const COUNTDOWN_URGENT_THRESHOLD_MS = 60_000;

/**
 * Tempo restante até `expiresAt` (ISO 8601), em milissegundos. Pode ser negativo
 * (já expirado) ou NaN (expiresAt inválido) — quem chama decide o que fazer.
 */
export function getRemainingMs(expiresAt, now = Date.now()) {
    const expiresAtMs = new Date(expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) return NaN;
    return expiresAtMs - now;
}

/** Trata NaN (data inválida) como expirado: nunca mostramos contador para um valor que não sabemos interpretar. */
export function isCountdownExpired(remainingMs) {
    return !Number.isFinite(remainingMs) || remainingMs <= 0;
}

/** "MM:SS", sempre com base no tempo restante (nunca decrementando um contador por conta própria). */
export function formatCountdown(remainingMs) {
    const totalSeconds = Number.isFinite(remainingMs) ? Math.max(0, Math.ceil(remainingMs / 1000)) : 0;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** true nos últimos COUNTDOWN_URGENT_THRESHOLD_MS (padrão 60s) antes de expirar. */
export function isCountdownUrgent(remainingMs, thresholdMs = COUNTDOWN_URGENT_THRESHOLD_MS) {
    return Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs <= thresholdMs;
}

/**
 * Valida o que foi lido do sessionStorage (string crua, possivelmente null/corrompida).
 * Retorna null para qualquer formato inesperado, nunca lança.
 */
export function parseStoredLinkCode(raw) {
    if (typeof raw !== "string" || !raw) return null;

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== "object") return null;
    const { code, expiresAt, telegramLink } = parsed;

    if (typeof code !== "string" || !code.trim()) return null;
    if (typeof expiresAt !== "string") return null;
    if (!Number.isFinite(new Date(expiresAt).getTime())) return null;

    return { code, expiresAt, telegramLink: typeof telegramLink === "string" ? telegramLink : undefined };
}

/**
 * Gerencia o setInterval do cronômetro, garantindo no máximo um ativo por vez.
 * `now`/`setIntervalFn`/`clearIntervalFn` são injetáveis para dar pra testar sem
 * temporizadores reais (ver tests/telegramLinkCountdown.test.js).
 */
export class TelegramLinkCountdownTimer {
    constructor({
        now = () => Date.now(),
        setIntervalFn = (callback, ms) => setInterval(callback, ms),
        clearIntervalFn = (id) => clearInterval(id),
        onTick,
        onExpired
    } = {}) {
        this.now = now;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.onTick = onTick;
        this.onExpired = onExpired;
        this.timerId = null;
        this.expiresAt = null;
    }

    isRunning() {
        return this.timerId !== null;
    }

    /** Para o intervalo (se houver) e esquece o expiresAt atual. Idempotente. */
    stop() {
        if (this.timerId !== null) {
            this.clearIntervalFn(this.timerId);
            this.timerId = null;
        }
        this.expiresAt = null;
    }

    /** Recalcula o tempo restante agora, por expiresAt — nunca por um contador decrescente. */
    tick() {
        if (this.expiresAt === null) return;
        const remainingMs = getRemainingMs(this.expiresAt, this.now());
        if (isCountdownExpired(remainingMs)) {
            this.stop();
            this.onExpired?.();
            return;
        }
        this.onTick?.(remainingMs);
    }

    /**
     * Inicia (ou reinicia, ex.: ao gerar outro código) a contagem para `expiresAt`.
     * Sempre para o intervalo anterior antes de criar outro, então nunca há dois ativos.
     */
    start(expiresAt) {
        this.stop();
        this.expiresAt = expiresAt;
        this.tick();
        if (this.timerId === null && this.expiresAt !== null) {
            this.timerId = this.setIntervalFn(() => this.tick(), 1000);
        }
    }
}
