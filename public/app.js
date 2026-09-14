const form = document.querySelector("#chat-form");
const questionInput = document.querySelector("#question");
const messages = document.querySelector("#messages");
const sendButton = document.querySelector("#send-button");
const feedback = document.querySelector("#form-feedback");
const suggestionButtons = document.querySelectorAll("[data-question]");

let isWaiting = false;

function scrollToLatest() {
    messages.scrollTop = messages.scrollHeight;
}

function addMessage(text, kind, sources = []) {
    const message = document.createElement("article");
    message.className = `message message-${kind}`;

    if (kind === "bot") {
        const label = document.createElement("div");
        label.className = "message-label";
        label.textContent = "MediBot";
        message.append(label);
    }

    const content = document.createElement("p");
    content.textContent = text;
    message.append(content);

    if (sources.length > 0) {
        const sourceText = document.createElement("p");
        sourceText.className = "message-source";
        sourceText.textContent = `Fonte${sources.length > 1 ? "s" : ""}: ${sources.join(", ")}`;
        message.append(sourceText);
    }

    messages.append(message);
    scrollToLatest();
}

function addLoading() {
    const loading = document.createElement("div");
    loading.id = "loading";
    loading.className = "loading";
    loading.innerHTML = "MediBot está consultando a bula <span class=\"dots\" aria-label=\"Carregando\"><i></i><i></i><i></i></span>";
    messages.append(loading);
    scrollToLatest();
}

function setWaiting(waiting) {
    isWaiting = waiting;
    sendButton.disabled = waiting;
    questionInput.disabled = waiting;
    suggestionButtons.forEach((button) => { button.disabled = waiting; });
}

async function sendQuestion(question) {
    const trimmedQuestion = question.trim();
    feedback.textContent = "";

    if (!trimmedQuestion) {
        feedback.textContent = "Digite uma pergunta para consultar a bula.";
        questionInput.focus();
        return;
    }
    if (isWaiting) return;

    addMessage(trimmedQuestion, "user");
    questionInput.value = "";
    setWaiting(true);
    addLoading();

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45000);

    try {
        const response = await fetch("/api/bula", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: trimmedQuestion }),
            signal: controller.signal
        });

        if (!response.ok) throw new Error("request-failed");
        const data = await response.json();

        if (!data || typeof data.answer !== "string" || !data.answer.trim()) {
            throw new Error("unexpected-response");
        }

        const sources = Array.isArray(data.sources)
            ? data.sources.filter((source) => typeof source === "string" && source.trim())
            : [];
        addMessage(data.answer, "bot", sources);
    } catch (error) {
        const errorName = error && typeof error === "object" ? error.name : "";
        const errorMessage = error && typeof error === "object" ? error.message : "";
        const message = errorName === "AbortError"
            ? "A consulta está demorando mais que o esperado. Tente novamente."
            : errorMessage === "unexpected-response"
                ? "O MediBot recebeu uma resposta inesperada. Tente novamente."
                : "Não foi possível obter uma resposta no momento. Verifique sua conexão e tente novamente.";
        addMessage(message, "bot");
    } finally {
        window.clearTimeout(timeout);
        document.querySelector("#loading")?.remove();
        setWaiting(false);
        questionInput.focus();
        scrollToLatest();
    }
}

form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendQuestion(questionInput.value);
});

suggestionButtons.forEach((button) => {
    button.addEventListener("click", () => {
        const question = button.dataset.question || "";
        questionInput.value = question;
        sendQuestion(question);
    });
});
