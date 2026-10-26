import test from "node:test";
import assert from "node:assert/strict";
import {
    buildDeleteConfirmCallbackData,
    buildHistoryOpenCallbackData,
    buildHistoryPageCallbackData,
    DELETE_CANCEL_CALLBACK_DATA,
    DELETE_CONFIRMATION_TTL_MINUTES,
    isDeleteConfirmationExpired,
    parseDeleteConfirmCallbackData,
    parseHistoryCallbackData
} from "../src/services/telegramHistoryCallback.ts";

test("buildHistoryPageCallbackData/parseHistoryCallbackData fazem round-trip", () => {
    const data = buildHistoryPageCallbackData(10);
    assert.equal(data, "h:p:10");
    assert.deepEqual(parseHistoryCallbackData(data), { type: "page", offset: 10 });
});

test("buildHistoryOpenCallbackData/parseHistoryCallbackData fazem round-trip e ficam bem abaixo de 64 bytes", () => {
    const data = buildHistoryOpenCallbackData(42, 5);
    assert.equal(data, "h:o:42:5");
    assert.ok(Buffer.byteLength(data, "utf8") < 64);
    assert.deepEqual(parseHistoryCallbackData(data), { type: "open", id: 42, offset: 5 });
});

test("parseHistoryCallbackData rejeita dados malformados", () => {
    const malformed = [
        "",
        "h:p:",
        "h:p:-1",
        "h:p:1.5",
        "h:p:abc",
        "h:o:1",
        "h:o:abc:1",
        "h:o:1:abc",
        "h:o:0:1",
        "h:o::1",
        "h:x:1",
        "qualquer-outra-coisa",
        "a".repeat(65)
    ];
    for (const value of malformed) {
        assert.equal(parseHistoryCallbackData(value), null, `deveria rejeitar: ${JSON.stringify(value)}`);
    }
});

test("parseDeleteConfirmCallbackData reconhece o prefixo e rejeita o resto", () => {
    const data = buildDeleteConfirmCallbackData(28_900_123);
    assert.equal(data, "a:y:28900123");
    assert.deepEqual(parseDeleteConfirmCallbackData(data), { minutesSinceEpoch: 28_900_123 });

    for (const malformed of ["a:y:", "a:y:-1", "a:y:abc", "a:n", "", "h:p:1"]) {
        assert.equal(parseDeleteConfirmCallbackData(malformed), null, `deveria rejeitar: ${JSON.stringify(malformed)}`);
    }
});

test("DELETE_CANCEL_CALLBACK_DATA não é confundido com uma confirmação", () => {
    assert.equal(parseDeleteConfirmCallbackData(DELETE_CANCEL_CALLBACK_DATA), null);
});

test("isDeleteConfirmationExpired: válido até o limite de minutos, expira depois", () => {
    const confirmedAt = 1_000_000;
    assert.equal(isDeleteConfirmationExpired(confirmedAt, confirmedAt), false);
    assert.equal(isDeleteConfirmationExpired(confirmedAt, confirmedAt + DELETE_CONFIRMATION_TTL_MINUTES), false);
    assert.equal(isDeleteConfirmationExpired(confirmedAt, confirmedAt + DELETE_CONFIRMATION_TTL_MINUTES + 1), true);
});
