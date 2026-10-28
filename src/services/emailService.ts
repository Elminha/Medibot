import nodemailer, { type Transporter } from "nodemailer";

const DEFAULT_FROM_NAME = "MediBot";
const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 465;
const CONNECTION_TIMEOUT_MS = 10_000;

export class EmailConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EmailConfigurationError";
    }
}

export class EmailDeliveryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EmailDeliveryError";
    }
}

let cachedTransporter: Transporter | undefined;

function getSmtpUser(): string {
    const user = process.env.SMTP_USER?.trim();
    if (!user) {
        throw new EmailConfigurationError("SMTP_USER não foi configurado.");
    }
    return user;
}

function getTransporter(): Transporter {
    if (cachedTransporter) {
        return cachedTransporter;
    }

    const user = getSmtpUser();
    const pass = process.env.SMTP_PASS;
    if (!pass) {
        throw new EmailConfigurationError("SMTP_PASS não foi configurado.");
    }

    cachedTransporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: true,
        auth: { user, pass },
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        greetingTimeout: CONNECTION_TIMEOUT_MS,
        socketTimeout: CONNECTION_TIMEOUT_MS
    });

    return cachedTransporter;
}

function getFromHeader(): string {
    const fromName = process.env.EMAIL_FROM_NAME?.trim() || DEFAULT_FROM_NAME;
    return `"${fromName}" <${getSmtpUser()}>`;
}

function buildPasswordResetEmailContent(resetLink: string): { text: string; html: string } {
    const text =
        "Recebemos um pedido para redefinir sua senha no MediBot.\n\n" +
        `Para criar uma nova senha, acesse o link abaixo:\n${resetLink}\n\n` +
        "Este link é válido por 30 minutos.\n\n" +
        "Se não foi você quem pediu, ignore este e-mail.";

    const html =
        "<p>Recebemos um pedido para redefinir sua senha no MediBot.</p>" +
        "<p>Para criar uma nova senha, acesse o link abaixo:</p>" +
        `<p><a href="${resetLink}">${resetLink}</a></p>` +
        "<p>Este link é válido por 30 minutos.</p>" +
        "<p>Se não foi você quem pediu, ignore este e-mail.</p>";

    return { text, html };
}

/**
 * Exportado como objeto (não como função solta) para poder ser mockado nos testes com
 * mock.method, no mesmo padrão já usado para `openai.responses.create` e `pool.query`.
 */
export const emailService = {
    async sendPasswordResetEmail(
        to: string,
        resetLink: string,
        transporter: Pick<Transporter, "sendMail"> = getTransporter()
    ): Promise<void> {
        const { text, html } = buildPasswordResetEmailContent(resetLink);

        try {
            await transporter.sendMail({
                from: getFromHeader(),
                to,
                subject: "Redefinição de senha - MediBot",
                text,
                html
            });
        } catch (error) {
            throw new EmailDeliveryError(
                error instanceof Error ? error.message : "Falha desconhecida ao enviar e-mail."
            );
        }
    }
};
