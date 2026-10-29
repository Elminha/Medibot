export const MAX_TIMES_PER_REMINDER = 12;
export const TIMES_PER_DAY_OPTIONS = [1, 2, 3, 4];
export const INTERVAL_HOURS_OPTIONS = [6, 8, 12];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BR_DATE_PATTERN = /^\d{2}\/\d{2}\/\d{4}$/;
const MINUTES_PER_DAY = 24 * 60;

// Índice = Date.getDay() (0 = domingo .. 6 = sábado); exibido em ordem Seg..Dom.
const WEEKDAY_SHORT_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
export const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function formatMinutesAsTime(totalMinutes) {
    const wrapped = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const hours = Math.floor(wrapped / 60);
    const minutes = wrapped % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Gera `count` horários igualmente espaçados em 24h a partir de `firstTime`, sempre
 * editáveis depois (isto só preenche um ponto de partida neutro: não é uma sugestão
 * de dose ou intervalo clínico).
 */
export function generateEvenlySpacedTimes(firstTime, count) {
    if (!TIME_PATTERN.test(firstTime) || !Number.isInteger(count) || count < 1 || count > MAX_TIMES_PER_REMINDER) {
        return [];
    }

    const [hour, minute] = firstTime.split(":").map(Number);
    const startMinutes = hour * 60 + minute;
    const stepMinutes = MINUTES_PER_DAY / count;
    const times = [];

    for (let index = 0; index < count; index += 1) {
        times.push(formatMinutesAsTime(startMinutes + stepMinutes * index));
    }

    return [...new Set(times)].sort();
}

/** "De X em X horas" reaproveita a mesma distribuição uniforme (count = 24 / X). */
export function generateIntervalTimes(firstTime, intervalHours) {
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24 || (24 % intervalHours) !== 0) {
        return [];
    }

    return generateEvenlySpacedTimes(firstTime, 24 / intervalHours);
}

/**
 * Modo "de X em X horas": ao editar o horário no índice `editedIndex` para `newTime`,
 * recalcula TODOS os outros mantendo o intervalo entre eles (sem mudar a ordem dos
 * campos). Só se usa neste modo — "1x a 4x" e "Escolher os horários" nunca chamam isto.
 */
export function recalculateIntervalTimes(times, editedIndex, newTime, intervalHours) {
    if (!Array.isArray(times) || !TIME_PATTERN.test(newTime) || !Number.isInteger(editedIndex)
        || editedIndex < 0 || editedIndex >= times.length || !Number.isInteger(intervalHours) || intervalHours < 1) {
        return Array.isArray(times) ? [...times] : [];
    }

    const [hour, minute] = newTime.split(":").map(Number);
    const baseMinutes = hour * 60 + minute;
    const stepMinutes = intervalHours * 60;
    return times.map((_, index) => formatMinutesAsTime(baseMinutes + (index - editedIndex) * stepMinutes));
}

export function isValidTimeString(value) {
    return typeof value === "string" && TIME_PATTERN.test(value);
}

/**
 * Valida "DD/MM/AAAA" como data de calendário real (rejeita 31/02, 30/02 etc.).
 * Aceita "_" nas posições (usado só internamente pelos testes/edição); um valor
 * com buraco nunca é uma data válida.
 */
export function isValidBrDate(value) {
    if (typeof value !== "string" || !BR_DATE_PATTERN.test(value)) return false;
    const [day, month, year] = value.split("/").map(Number);
    if (month < 1 || month > 12 || day < 1) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** "DD/MM/AAAA" validado -> "YYYY-MM-DD" (valor interno/API); null se inválido. */
export function brDateToIso(value) {
    if (!isValidBrDate(value)) return null;
    const [day, month, year] = value.split("/");
    return `${year}-${month}-${day}`;
}

/**
 * Regra do botão "Limpar" do seletor nativo (<input type="date">): valor vazio
 * limpa o campo mascarado de volta ao estado "nada digitado" (null); valor
 * preenchido é um "YYYY-MM-DD" válido vindo do próprio picker, repassado como
 * está. O "Limpar" nativo dispara input/change com value="" só fechando o
 * popup — sem isto, o campo de texto ficava com a data anterior.
 */
export function resolveStartsOnFromNativePicker(nativeValue) {
    return nativeValue ? nativeValue : null;
}

// ===== Edição com posições fixas (campos de horário e data) =====
//
// Cada campo é um conjunto de "células" (1 dígito cada: 4 para "HH:MM", 8 para
// "DD/MM/AAAA"). O valor exibido é sempre derivado das células, nunca editado como
// texto livre: um dígito digitado SOBRESCREVE a célula sob o cursor (nunca empurra
// as outras), Backspace/Delete limpam uma célula específica, e célula vazia com
// alguma célula preenchida depois dela aparece como "_" (buraco); buracos à direita
// do último dígito preenchido somem. Isso corrige o bug de "reflow": antes, apagar
// o "3" de "13:00" compactava tudo para "10:0" porque a máscara relia em dígitos
// corridos, sem noção de posição.

const HOLE = "_";

function padCells(chars, total) {
    const cells = chars.slice(0, total);
    while (cells.length < total) cells.push(null);
    return cells;
}

/** String exibida -> células (dígito ou null), removendo os separadores fixos. */
function parseCellsFromDisplay(value, totalCells, separators) {
    const chars = [...(typeof value === "string" ? value : "")]
        .filter((ch) => !separators.has(ch))
        .map((ch) => (ch === HOLE ? null : ch));
    return padCells(chars, totalCells);
}

/** Quantas células (dígito/buraco) existem antes de `index` na string exibida —
 * os separadores não contam, então as duas posições ao redor de um separador
 * (ex.: antes e depois do ":") resolvem para a mesma célula-limite. */
function countCellsBeforeIndex(value, index, separators) {
    let count = 0;
    const limit = Math.min(index, value.length);
    for (let i = 0; i < limit; i += 1) if (!separators.has(value[i])) count += 1;
    return count;
}

/**
 * Células -> string exibida + offsets[i] = posição (índice na string) do limite
 * "antes da célula i", para i de 0 a células.length. Um segmento só aparece
 * quando tem algo preenchido nele ou depois dele; um segmento totalmente
 * preenchido sempre mostra o separador seguinte (é assim que "09" + nada nos
 * minutos ainda aparece como "09:", com o cursor já pulando para lá).
 */
function renderMaskedCells(cells, segmentLengths, separator) {
    const total = cells.length;
    let lastFilled = -1;
    for (let i = 0; i < total; i += 1) if (cells[i] != null) lastFilled = i;

    const offsets = new Array(total + 1).fill(0);
    let text = "";
    let cellStart = 0;
    let stopped = lastFilled < 0;
    if (stopped) offsets.fill(0);

    for (const segmentLength of segmentLengths) {
        const segmentEnd = cellStart + segmentLength;
        if (stopped || lastFilled < cellStart) {
            for (let i = cellStart; i <= segmentEnd; i += 1) offsets[i] = text.length;
            stopped = true;
            cellStart = segmentEnd;
            continue;
        }
        const segmentFilled = cells.slice(cellStart, segmentEnd).every((cell) => cell != null);
        const somethingAfter = lastFilled >= segmentEnd;
        const showSeparator = (segmentFilled || somethingAfter) && segmentEnd < total;
        const renderEnd = Math.min(segmentEnd, lastFilled + 1);
        for (let i = cellStart; i < renderEnd; i += 1) {
            offsets[i] = text.length;
            text += cells[i] ?? HOLE;
        }
        for (let i = renderEnd; i < segmentEnd; i += 1) offsets[i] = text.length;
        if (showSeparator) text += separator;
        offsets[segmentEnd] = text.length;
        cellStart = segmentEnd;
    }
    return { text, offsets };
}

/**
 * Aplica uma edição (digitar, colar, Backspace, Delete) a um campo de células e
 * devolve o novo valor exibido e a posição do cursor — função genérica usada por
 * editTimeField e editDateField (a diferença entre os dois é só o formato: nº de
 * células, tamanho dos segmentos, separador e a regra de atalho do horário).
 *
 * `action`: { type: "insert", text } (1 dígito, respeita seleção) |
 *           { type: "paste", text } (substitui o campo inteiro) |
 *           { type: "backspace" } | { type: "delete" }
 * `onInsertDigit(cells, cellIndex, digit)` decide como um dígito avulso é
 * aplicado (permite ao horário o atalho "3-9 na hora emite '0d' e pula pro
 * minuto"); deve devolver o novo índice do cursor (em células).
 */
function editMaskedCells({ value, selectionStart, selectionEnd, action }, { totalCells, segmentLengths, separator, onInsertDigit }) {
    const text = typeof value === "string" ? value : "";
    const separators = new Set([separator]);
    const start = Number.isInteger(selectionStart) ? selectionStart : text.length;
    const end = Number.isInteger(selectionEnd) ? selectionEnd : start;

    if (action?.type === "paste") {
        const digits = (action.text || "").replace(/\D/g, "").slice(0, totalCells).split("");
        const cells = padCells(digits, totalCells);
        const rendered = renderMaskedCells(cells, segmentLengths, separator);
        return { value: rendered.text, cursor: rendered.offsets[totalCells] };
    }

    const cells = parseCellsFromDisplay(text, totalCells, separators);
    let cellStart = countCellsBeforeIndex(text, start, separators);
    let cellEnd = countCellsBeforeIndex(text, end, separators);
    if (cellEnd < cellStart) [cellStart, cellEnd] = [cellEnd, cellStart];

    const newCells = cells.slice();
    let newCellIndex = cellStart;
    const hasSelection = cellStart !== cellEnd;

    if (action?.type === "backspace") {
        if (hasSelection) {
            for (let i = cellStart; i < cellEnd; i += 1) newCells[i] = null;
            newCellIndex = cellStart;
        } else if (cellStart > 0) {
            newCells[cellStart - 1] = null;
            newCellIndex = cellStart - 1;
        }
    } else if (action?.type === "delete") {
        if (hasSelection) {
            for (let i = cellStart; i < cellEnd; i += 1) newCells[i] = null;
            newCellIndex = cellStart;
        } else if (cellStart < totalCells) {
            newCells[cellStart] = null;
            newCellIndex = cellStart;
        }
    } else if (action?.type === "insert") {
        const digit = (action.text || "").replace(/\D/g, "").slice(0, 1);
        if (!digit) {
            const rendered = renderMaskedCells(cells, segmentLengths, separator);
            return { value: rendered.text, cursor: rendered.offsets[cellStart] };
        }
        if (hasSelection) for (let i = cellStart; i < cellEnd; i += 1) newCells[i] = null;
        newCellIndex = cellStart < totalCells ? onInsertDigit(newCells, cellStart, digit) : cellStart;
    }

    const rendered = renderMaskedCells(newCells, segmentLengths, separator);
    const cursorCell = Math.max(0, Math.min(newCellIndex, totalCells));
    return { value: rendered.text, cursor: rendered.offsets[cursorCell] };
}

const TIME_SEGMENTS = [2, 2];

function insertTimeDigit(cells, cellIndex, digit) {
    // Atalho: 1º dígito da hora (índice 0) de 3-9 só cabe nas unidades ("0d"), e já
    // pula pro minuto; o mesmo para o 1º dígito do minuto (índice 2) de 6-9.
    if (cellIndex === 0 && digit >= "3" && digit <= "9") {
        cells[0] = "0";
        cells[1] = digit;
        return 2;
    }
    if (cellIndex === 2 && digit >= "6" && digit <= "9") {
        cells[2] = "0";
        cells[3] = digit;
        return 4;
    }
    cells[cellIndex] = digit;
    return cellIndex + 1;
}

/**
 * Edição com posição fixa do campo de horário ("HH:MM"): um dígito sobrescreve a
 * célula sob o cursor e avança (pulando o ":"); com seleção, limpa as células
 * selecionadas e digita na primeira; Backspace/Delete limpam uma célula e movem o
 * cursor para ela; colar substitui o valor inteiro. `value`/`selectionStart`/
 * `selectionEnd` são os do campo de texto real (ou simulados num teste);
 * `action` descreve a tecla/operação. Devolve `{ value, cursor }` já prontos para
 * `input.value` e `input.setSelectionRange(cursor, cursor)`.
 */
export function editTimeField({ value, selectionStart, selectionEnd, action }) {
    return editMaskedCells({ value, selectionStart, selectionEnd, action }, {
        totalCells: 4, segmentLengths: TIME_SEGMENTS, separator: ":", onInsertDigit: insertTimeDigit
    });
}

const DATE_SEGMENTS = [2, 2, 4];

function insertDateDigit(cells, cellIndex, digit) {
    cells[cellIndex] = digit;
    return cellIndex + 1;
}

/** Mesma edição com posição fixa, para "DD/MM/AAAA" (8 células, sem atalhos de
 * dígito — dia/mês/ano não têm uma "unidade implícita" como a hora/minuto têm). */
export function editDateField({ value, selectionStart, selectionEnd, action }) {
    return editMaskedCells({ value, selectionStart, selectionEnd, action }, {
        totalCells: 8, segmentLengths: DATE_SEGMENTS, separator: "/", onInsertDigit: insertDateDigit
    });
}

/** Resolve um lado do ":" (0-2 caracteres, dígito ou "_") num dígito duplo: um só
 * dígito presente é sempre tratado como as unidades, com as dezenas em "0" — ex.:
 * "1_" e "_3" (buraco interior, ver editTimeField) e também "1" (sobra à direita,
 * ex.: minuto só com o primeiro dígito) todos colapsam do mesmo jeito. null quando
 * não há dígito nenhum (lado vazio ou só buracos). */
function resolveTimeHalf(part) {
    if (!part) return null;
    const digits = [...part].filter((ch) => /\d/.test(ch));
    if (digits.length === 0) return null;
    if (digits.length >= 2) return digits.slice(0, 2).join("");
    return `0${digits[0]}`;
}

/**
 * Normalização ao sair do campo (blur) ou Enter: completa horários parciais,
 * incluindo buracos ("_") deixados pela edição (editTimeField). "1_:00" vira
 * "01:00"; "_3:00" vira "03:00"; "9" vira "09:00"; "930" vira "09:30". Só formata
 * ("HH:MM"); não valida o intervalo (ver isValidTimeString) — "25:99" normaliza
 * para "25:99", que fica inválido mas com o formato certo para a mensagem de erro
 * mostrar o valor digitado.
 */
export function normalizeTypedTime(rawValue) {
    const str = typeof rawValue === "string" ? rawValue : "";
    if (!str) return null;
    if (str.includes(":")) {
        const [hourPart, minutePart = ""] = str.split(":");
        const hour = resolveTimeHalf(hourPart);
        const minute = resolveTimeHalf(minutePart);
        if (hour == null && minute == null) return null;
        return `${hour ?? "00"}:${minute ?? "00"}`;
    }
    // Sem ":": dígitos corridos (ex.: colado sem passar por editTimeField) — usa a
    // contagem de dígitos: 1-2 = hora; 3 = 1 dígito de hora + 2 de minuto; 4 = 2 de
    // hora + 2 de minuto.
    const digits = str.replace(/\D/g, "");
    if (!digits) return null;
    const [hourDigits, minuteDigits] = digits.length <= 2 ? [digits, "0"]
        : digits.length === 3 ? [digits.slice(0, 1), digits.slice(1)]
        : [digits.slice(0, 2), digits.slice(2, 4)];
    return `${hourDigits.padStart(2, "0")}:${minuteDigits.padStart(2, "0")}`;
}

/** ArrowUp/ArrowDown (±1 min) e PageUp/PageDown (±1h) do campo de horário, com
 * volta em 23:59/00:00. Aceita um valor em edição (com buracos) como base,
 * normalizando antes de somar o passo. */
export function stepTimeValue(value, deltaMinutes) {
    if (!Number.isInteger(deltaMinutes)) return value;
    const normalized = isValidTimeString(value) ? value : normalizeTypedTime(value);
    const base = isValidTimeString(normalized) ? normalized : "00:00";
    const [hour, minute] = base.split(":").map(Number);
    const wrapped = (((hour * 60 + minute) + deltaMinutes) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    return formatMinutesAsTime(wrapped);
}

/**
 * Normalização ao sair do campo (blur) ou Enter: preenche buracos ("_") deixados
 * pela edição (editDateField) com "0", posicionalmente (sem o atalho de
 * "unidades" do horário — dia/mês/ano não têm essa ambiguidade). Só formata;
 * "Valide data real" é isValidBrDate.
 */
export function normalizeTypedDateBr(rawValue) {
    const str = typeof rawValue === "string" ? rawValue : "";
    if (!str) return null;
    return str.replace(new RegExp(HOLE, "g"), "0");
}

export function formatWeekdaysSummary(weekdays) {
    if (!Array.isArray(weekdays) || weekdays.length === 0) {
        return "Todos os dias";
    }

    const unique = new Set(weekdays);
    return WEEKDAY_DISPLAY_ORDER
        .filter((day) => unique.has(day))
        .map((day) => WEEKDAY_SHORT_LABELS[day])
        .join(", ");
}

export function formatDateBr(dateKey) {
    if (typeof dateKey !== "string" || !DATE_PATTERN.test(dateKey)) {
        return "";
    }

    const [year, month, day] = dateKey.split("-");
    return `${day}/${month}/${year}`;
}

/** ends_on = starts_on + totalDays - 1 (inclusivo), em aritmética de calendário (sem fuso). */
export function computeEndsOn(startsOn, totalDays) {
    if (!DATE_PATTERN.test(startsOn) || !Number.isInteger(totalDays) || totalDays < 1) {
        return null;
    }

    const [year, month, day] = startsOn.split("-").map(Number);
    const end = new Date(Date.UTC(year, month - 1, day + totalDays - 1));
    return `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}`;
}

/** Inverso de computeEndsOn: quantos dias (inclusive) entre startsOn e endsOn. */
export function countDaysInclusive(startsOn, endsOn) {
    if (!DATE_PATTERN.test(startsOn) || !DATE_PATTERN.test(endsOn)) {
        return null;
    }

    const [startYear, startMonth, startDay] = startsOn.split("-").map(Number);
    const [endYear, endMonth, endDay] = endsOn.split("-").map(Number);
    const start = Date.UTC(startYear, startMonth - 1, startDay);
    const end = Date.UTC(endYear, endMonth - 1, endDay);
    const days = Math.round((end - start) / 86_400_000) + 1;
    return days >= 1 ? days : null;
}

/** Resumo de uma linha usado antes de salvar e na lista de lembretes. */
export function summarizeSchedule({ times, weekdays, endsOn, status }) {
    const timesLabel = Array.isArray(times) && times.length ? times.join(", ") : "sem horário definido";
    const daysLabel = formatWeekdaysSummary(weekdays);
    const durationLabel = endsOn ? `até ${formatDateBr(endsOn)}` : "sem data para terminar";
    const statusLabel = status === "paused" ? " (pausado)" : status === "ended" ? " (encerrado)" : "";

    return `${timesLabel} — ${daysLabel} — ${durationLabel}${statusLabel}`;
}

export function summarizeReminder({ medicationName, times, weekdays, endsOn, status }) {
    return `${medicationName} — ${summarizeSchedule({ times, weekdays, endsOn, status })}`;
}
