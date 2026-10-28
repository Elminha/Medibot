import test from "node:test";
import assert from "node:assert/strict";

process.env.SMTP_USER ||= "medibot@exemplo.com";
process.env.EMAIL_FROM_NAME ||= "MediBot Teste";

const { emailService, EmailDeliveryError } = await import("../src/services/emailService.ts");

function fakeTransporter(sendMail: (options: Record<string, unknown>) => Promise<unknown>) {
    return { sendMail };
}

test("sendPasswordResetEmail envia para o destinatário certo, com o link, validade de 30 min e sem a senha", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const transporter = fakeTransporter(async (options) => {
        calls.push(options);
        return { messageId: "1" };
    });

    await emailService.sendPasswordResetEmail(
        "usuario@exemplo.com",
        "https://medibot.exemplo.com/#redefinir=abc123",
        transporter
    );

    assert.equal(calls.length, 1);
    const [sent] = calls;
    assert.equal(sent.to, "usuario@exemplo.com");
    assert.match(String(sent.from), /MediBot Teste/);
    assert.match(String(sent.subject), /senha/i);
    assert.match(String(sent.text), /https:\/\/medibot\.exemplo\.com\/#redefinir=abc123/);
    assert.match(String(sent.html), /https:\/\/medibot\.exemplo\.com\/#redefinir=abc123/);
    assert.match(String(sent.text), /30 minutos/);
});

test("sendPasswordResetEmail lança EmailDeliveryError (tratável) quando o transporte falha", async () => {
    const transporter = fakeTransporter(async () => {
        throw new Error("conexão SMTP recusada");
    });

    await assert.rejects(
        () => emailService.sendPasswordResetEmail("usuario@exemplo.com", "https://medibot.exemplo.com/#redefinir=xyz", transporter),
        EmailDeliveryError
    );
});
