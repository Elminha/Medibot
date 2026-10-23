import {
    getNotificationAvailability,
    startReminderSchedulerIfAllowed
} from "./reminderNotifications.js";

const form = document.querySelector("#chat-form");
const questionInput = document.querySelector("#question");
const messages = document.querySelector("#messages");
const sendButton = document.querySelector("#send-button");
const feedback = document.querySelector("#form-feedback");
const suggestionButtons = document.querySelectorAll("[data-question]");
const authTokenStorageKey = "medibot_auth_token";
const authView = document.querySelector("#auth-view");
const authenticatedApp = document.querySelector("#authenticated-app");
const loginPanel = document.querySelector("#login-panel");
const registerPanel = document.querySelector("#register-panel");
const loginForm = document.querySelector("#login-form");
const registerForm = document.querySelector("#register-form");
const loginFeedback = document.querySelector("#login-feedback");
const registerFeedback = document.querySelector("#register-feedback");
const loggedUser = document.querySelector("#logged-user");
const userAvatar = document.querySelector(".user-avatar");
const historyList = document.querySelector("#history-list");
const historyDetail = document.querySelector("#history-detail");

const themeStorageKey = "medibot_theme";
const themeToggleButton = document.querySelector("#theme-toggle");

function getPreferredTheme() {
    try {
        const stored = window.localStorage.getItem(themeStorageKey);
        if (stored === "light" || stored === "dark") return stored;
    } catch {
        // ignore storage access errors
    }
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    themeToggleButton?.setAttribute("aria-pressed", String(theme === "dark"));
}

function setTheme(theme) {
    applyTheme(theme);
    try {
        window.localStorage.setItem(themeStorageKey, theme);
    } catch {
        // ignore storage access errors
    }
}

applyTheme(getPreferredTheme());

themeToggleButton?.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    setTheme(current === "dark" ? "light" : "dark");
});

const emptyStateIcons = {
    medication: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/></svg>',
    reminder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>'
};

function buildEmptyState(iconKey, text, actionLabel, onAction) {
    const container = document.createElement("div");
    container.className = "medication-state";
    const icon = document.createElement("span");
    icon.innerHTML = emptyStateIcons[iconKey] || "";
    const message = document.createElement("span");
    message.className = "empty-state-title";
    message.textContent = text;
    container.append(icon, message);
    if (actionLabel && onAction) {
        const button = medicationButton(actionLabel, "secondary-button", onAction);
        container.append(button);
    }
    return container;
}

let isWaiting = false;
let notificationScheduler = null;
let reminderRefreshTimer = null;
let currentAuthUserId = null;

function getAuthToken() {
    return window.localStorage.getItem(authTokenStorageKey)?.trim() || "";
}

async function authenticatedFetch(url, options = {}) {
    const token = getAuthToken();
    if (!token) throw new Error("authentication-required");

    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
        showAuthentication();
        throw new Error("authentication-required");
    }
    return response;
}

function showLogin(message = "", success = false) {
    authView.hidden = false;
    authenticatedApp.hidden = true;
    loginPanel.hidden = false;
    registerPanel.hidden = true;
    loginFeedback.textContent = message;
    loginFeedback.classList.toggle("success", success);
}

function showRegister() {
    loginPanel.hidden = true;
    registerPanel.hidden = false;
    loginFeedback.textContent = "";
    registerFeedback.textContent = "";
    registerFeedback.classList.remove("success");
    document.querySelector("#register-name").focus();
}

function clearApplicationData() {
    stopReminderNotifications();
    currentAuthUserId = null;
    messages.replaceChildren();
    document.querySelector(".suggestions").hidden = false;
    addMessage("Olá! Eu sou o MediBot. Posso ajudar você a compreender informações presentes nas bulas dos medicamentos disponíveis no sistema. Faça uma pergunta sobre um medicamento.", "bot");
    medicationList.replaceChildren();
    reminderList.replaceChildren();
    historyList.replaceChildren();
    historyDetail.replaceChildren();
    renderTelegramLinked(false);
    telegramCodeBox.hidden = true;
    telegramOpenLink.hidden = true;
    questionInput.value = "";
    medicationForm.reset();
    reminderForm.reset();
    reminderActiveInput.checked = true;
    currentMedications = [];
}

function showAuthentication(message = "") {
    window.localStorage.removeItem(authTokenStorageKey);
    clearApplicationData();
    showLogin(message);
}

function showApplication(user) {
    authView.hidden = true;
    authenticatedApp.hidden = false;
    loggedUser.textContent = user.name ? `Olá, ${user.name}` : "Usuário autenticado";
    if (userAvatar) userAvatar.textContent = user.name?.trim()?.charAt(0)?.toUpperCase() || "M";
    currentAuthUserId = user.id;
    setView("chat");
    renderTelegramLinked(Boolean(user.telegramLinked));
    const reminderLoad = loadReminders();
    if (getNotificationAvailability({ notification: window.Notification, isSecureContext: window.isSecureContext }) === "enabled") {
        setNotificationState("pending", "Permissão concedida. Carregando seus lembretes para retomar as notificações…");
    } else {
        updateNotificationPermissionState();
    }
    Promise.all([loadMedications(), reminderLoad, loadQueryHistory()]).then(([, reminders]) => {
        if (Array.isArray(reminders)) {
            initializeReminderScheduler(reminders);
        } else if (getNotificationAvailability({ notification: window.Notification, isSecureContext: window.isSecureContext }) === "enabled") {
            setNotificationState("disabled", "Não foi possível carregar seus lembretes. Verifique a conexão e tente ativar novamente.");
        }
    });
    window.clearInterval(reminderRefreshTimer);
    reminderRefreshTimer = window.setInterval(() => {
        refreshReminderNotifications();
    }, 60_000);
}

async function readError(response, fallback) {
    try {
        const data = await response.json();
        return typeof data.error === "string" ? data.error : fallback;
    } catch {
        return fallback;
    }
}

function scrollToLatest() {
    messages.scrollTop = messages.scrollHeight;
}

function renderMarkdown(container, text) {
    if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
        container.textContent = text;
        return;
    }
    const html = marked.parse(text, { breaks: true });
    container.innerHTML = DOMPurify.sanitize(html);
}

function addMessage(text, kind, sources = []) {
    const message = document.createElement("article");
    message.className = `message message-${kind}`;

    if (kind === "bot") {
        const label = document.createElement("div");
        label.className = "message-label";
        label.textContent = "MediBot";
        message.append(label);

        const content = document.createElement("div");
        content.className = "markdown-content";
        renderMarkdown(content, text);
        message.append(content);
    } else {
        const content = document.createElement("p");
        content.textContent = text;
        message.append(content);
    }

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

    const token = window.localStorage.getItem(authTokenStorageKey)?.trim();
    if (!token) {
        feedback.textContent = "Faça login para consultar uma bula.";
        return;
    }

    addMessage(trimmedQuestion, "user");
    document.querySelector(".suggestions").hidden = true;
    questionInput.value = "";
    setWaiting(true);
    addLoading();

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45000);

    try {
        const response = await authenticatedFetch("/api/bula", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`
            },
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
        loadQueryHistory();
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

questionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
    }
});

suggestionButtons.forEach((button) => {
    button.addEventListener("click", () => {
        const question = button.dataset.question || "";
        questionInput.value = question;
        sendQuestion(question);
    });
});

const medicationForm = document.querySelector("#medication-form");
const medicationNameInput = document.querySelector("#medication-name");
const medicationDosageInput = document.querySelector("#medication-dosage");
const medicationInstructionsInput = document.querySelector("#medication-instructions");
const medicationFeedback = document.querySelector("#medication-feedback");
const medicationList = document.querySelector("#medication-list");
const addMedicationButton = document.querySelector("#add-medication-button");
const reminderForm = document.querySelector("#reminder-form");
const reminderMedicationInput = document.querySelector("#reminder-medication");
const reminderTimeInput = document.querySelector("#reminder-time");
const reminderFrequencyInput = document.querySelector("#reminder-frequency");
const reminderActiveInput = document.querySelector("#reminder-active");
const reminderFeedback = document.querySelector("#reminder-feedback");
const reminderList = document.querySelector("#reminder-list");
const addReminderButton = document.querySelector("#add-reminder-button");
const frequencyLabels = {
    daily: "Todos os dias",
    weekly: "Semanalmente",
    weekdays: "Dias úteis",
    custom: "Personalizada"
};
let currentMedications = [];

function setMedicationFeedback(message = "", type = "") {
    medicationFeedback.textContent = message;
    medicationFeedback.className = `medication-feedback${type ? ` feedback-${type}` : ""}`;
}

function setMedicationLoading(isLoading) {
    medicationList.setAttribute("aria-busy", String(isLoading));
    addMedicationButton.disabled = isLoading;
}

function medicationBody(name, dosage, instructions, active = true) {
    return {
        name: name.trim(),
        dosage: dosage.trim() || null,
        instructions: instructions.trim() || null,
        active
    };
}

async function medicationError(response, fallback) {
    try {
        const data = await response.json();
        return typeof data.error === "string" ? data.error : fallback;
    } catch {
        return fallback;
    }
}

function medicationButton(text, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
}

function renderMedicationCard(medication) {
    const card = document.createElement("article");
    card.className = "medication-card";
    const header = document.createElement("div");
    header.className = "medication-card-header";
    const name = document.createElement("h3");
    name.className = "medication-name";
    name.textContent = medication.name;
    const status = document.createElement("span");
    status.className = `medication-status${medication.active ? "" : " inactive"}`;
    status.textContent = medication.active ? "Ativo" : "Inativo";
    header.append(name, status);
    card.append(header);

    if (medication.dosage) {
        const meta = document.createElement("div");
        meta.className = "medication-meta";
        const dosePill = document.createElement("span");
        dosePill.className = "medication-dose-pill";
        dosePill.textContent = medication.dosage;
        meta.append(dosePill);
        card.append(meta);
    }

    if (medication.instructions) {
        const instructions = document.createElement("p");
        instructions.className = "medication-details";
        instructions.textContent = `Instruções: ${medication.instructions}`;
        card.append(instructions);
    }

    const actions = document.createElement("div");
    actions.className = "medication-actions";
    actions.append(
        medicationButton("Editar", "secondary-button", () => showMedicationEditor(card, medication)),
        medicationButton("Excluir", "danger-button", () => deleteMedication(medication.id, medication.name))
    );
    card.append(actions);
    return card;
}

function showMedicationEditor(card, medication) {
    if (card.querySelector(".edit-form")) return;

    const form = document.createElement("form");
    form.className = "edit-form";
    const fields = document.createElement("div");
    fields.className = "edit-fields";

    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Nome";
    const nameInput = document.createElement("input");
    nameInput.name = "name";
    nameInput.maxLength = 255;
    nameInput.value = medication.name;
    nameLabel.append(nameInput);

    const dosageLabel = document.createElement("label");
    dosageLabel.textContent = "Dosagem (opcional)";
    const dosageInput = document.createElement("input");
    dosageInput.name = "dosage";
    dosageInput.maxLength = 255;
    dosageInput.value = medication.dosage || "";
    dosageLabel.append(dosageInput);

    const instructionsLabel = document.createElement("label");
    instructionsLabel.className = "edit-instructions";
    instructionsLabel.textContent = "Instruções (opcional)";
    const instructionsInput = document.createElement("textarea");
    instructionsInput.name = "instructions";
    instructionsInput.rows = 2;
    instructionsInput.maxLength = 1000;
    instructionsInput.value = medication.instructions || "";
    instructionsLabel.append(instructionsInput);

    const activeLabel = document.createElement("label");
    activeLabel.className = "active-field";
    const activeInput = document.createElement("input");
    activeInput.name = "active";
    activeInput.type = "checkbox";
    activeInput.checked = medication.active;
    activeLabel.append(activeInput, document.createTextNode(" Medicamento ativo"));
    fields.append(nameLabel, dosageLabel, instructionsLabel, activeLabel);

    const actions = document.createElement("div");
    actions.className = "edit-actions";
    const saveButton = medicationButton("Salvar alterações", "primary-button", () => {});
    saveButton.type = "submit";
    actions.append(saveButton, medicationButton("Cancelar", "secondary-button", () => form.remove()));
    form.append(fields, actions);

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const updatedName = nameInput.value.trim();
        nameInput.classList.toggle("input-error", !updatedName);
        nameInput.setAttribute("aria-invalid", String(!updatedName));
        if (!updatedName) {
            setMedicationFeedback("Informe o nome do medicamento para salvar as alterações.", "error");
            nameInput.focus();
            return;
        }

        saveButton.disabled = true;
        setMedicationFeedback("");
        try {
            const response = await authenticatedFetch(`/api/medications/${medication.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(medicationBody(updatedName, dosageInput.value, instructionsInput.value, activeInput.checked))
            });
            if (!response.ok) throw new Error(await medicationError(response, "Não foi possível atualizar o medicamento."));
            setMedicationFeedback("Medicamento atualizado com sucesso.", "success");
            await Promise.all([loadMedications(), loadReminders()]);
        } catch (error) {
            setMedicationFeedback(error instanceof Error ? error.message : "Não foi possível atualizar o medicamento.", "error");
        } finally {
            saveButton.disabled = false;
        }
    });

    card.append(form);
    nameInput.focus();
}

function renderMedications(medications) {
    currentMedications = medications;
    populateReminderMedicationOptions();
    medicationList.replaceChildren();
    if (!medications.length) {
        medicationList.append(buildEmptyState(
            "medication",
            "Você ainda não cadastrou medicamentos.",
            "Adicionar medicamento",
            () => medicationNameInput.focus()
        ));
        return;
    }
    medications.forEach((medication) => medicationList.append(renderMedicationCard(medication)));
}

async function loadMedications() {
    setMedicationLoading(true);
    medicationList.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "medication-state";
    loading.textContent = "Carregando medicamentos...";
    medicationList.append(loading);

    try {
        const response = await authenticatedFetch("/api/medications");
        if (!response.ok) throw new Error(await medicationError(response, "Não foi possível carregar os medicamentos."));
        const data = await response.json();
        if (!data || !Array.isArray(data.medications)) throw new Error("Resposta inesperada ao carregar medicamentos.");
        renderMedications(data.medications);
    } catch (error) {
        medicationList.replaceChildren();
        const message = document.createElement("p");
        message.className = "medication-state feedback-error";
        message.textContent = error instanceof Error ? error.message : "Não foi possível carregar os medicamentos.";
        medicationList.append(message);
        setMedicationFeedback("Verifique sua conexão e tente novamente.", "error");
    } finally {
        setMedicationLoading(false);
    }
}

async function deleteMedication(id, name) {
    if (!window.confirm(`Excluir o medicamento "${name}"?`)) return;
    setMedicationFeedback("");
    try {
        const response = await authenticatedFetch(`/api/medications/${id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(await medicationError(response, "Não foi possível excluir o medicamento."));
        setMedicationFeedback("Medicamento excluído com sucesso.", "success");
        await Promise.all([loadMedications(), loadReminders()]);
    } catch (error) {
        setMedicationFeedback(error instanceof Error ? error.message : "Não foi possível excluir o medicamento.", "error");
    }
}

medicationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = medicationNameInput.value.trim();
    medicationNameInput.classList.toggle("input-error", !name);
    medicationNameInput.setAttribute("aria-invalid", String(!name));
    if (!name) {
        setMedicationFeedback("Informe o nome do medicamento para adicioná-lo.", "error");
        medicationNameInput.focus();
        return;
    }

    setMedicationLoading(true);
    setMedicationFeedback("");
    try {
        const response = await authenticatedFetch("/api/medications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(medicationBody(name, medicationDosageInput.value, medicationInstructionsInput.value))
        });
        if (!response.ok) throw new Error(await medicationError(response, "Não foi possível adicionar o medicamento."));
        medicationForm.reset();
        medicationNameInput.setAttribute("aria-invalid", "false");
        setMedicationFeedback("Medicamento adicionado com sucesso.", "success");
        await Promise.all([loadMedications(), loadReminders()]);
        medicationNameInput.focus();
    } catch (error) {
        setMedicationFeedback(error instanceof Error ? error.message : "Não foi possível adicionar o medicamento.", "error");
    } finally {
        setMedicationLoading(false);
    }
});

function setReminderFeedback(message = "", type = "") {
    reminderFeedback.textContent = message;
    reminderFeedback.className = `reminder-feedback${type ? ` feedback-${type}` : ""}`;
}

function setReminderLoading(isLoading) {
    reminderList.setAttribute("aria-busy", String(isLoading));
    addReminderButton.disabled = isLoading || currentMedications.length === 0;
}

function reminderError(response, fallback) {
    return medicationError(response, fallback);
}

function populateMedicationSelect(select, selectedId) {
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = currentMedications.length
        ? "Selecione um medicamento"
        : "Cadastre um medicamento para criar lembretes";
    select.append(placeholder);

    currentMedications.forEach((medication) => {
        const option = document.createElement("option");
        option.value = String(medication.id);
        option.textContent = medication.name;
        option.selected = Number(selectedId) === medication.id;
        select.append(option);
    });
    select.disabled = currentMedications.length === 0;
}

function populateReminderMedicationOptions() {
    const selectedId = reminderMedicationInput.value;
    populateMedicationSelect(reminderMedicationInput, selectedId);
    addReminderButton.disabled = currentMedications.length === 0;
}

function reminderBody(medicationId, time, frequency, active) {
    return { medicationId: Number(medicationId), time, frequency, active };
}

function reminderButton(text, className, onClick) {
    return medicationButton(text, className, onClick);
}

function frequencyLabel(frequency) {
    return frequencyLabels[frequency] || frequency;
}

function renderReminderCard(reminder) {
    const card = document.createElement("article");
    card.className = "reminder-card";
    const header = document.createElement("div");
    header.className = "reminder-card-header";
    const name = document.createElement("h3");
    name.className = "reminder-medication-name";
    name.textContent = reminder.medicationName;
    const status = document.createElement("span");
    status.className = `reminder-status${reminder.active ? "" : " inactive"}`;
    status.textContent = reminder.active ? "Ativo" : "Inativo";
    header.append(name, status);

    const meta = document.createElement("div");
    meta.className = "reminder-meta";
    const timeBadge = document.createElement("span");
    timeBadge.className = "reminder-time-badge";
    timeBadge.textContent = reminder.time;
    const frequency = document.createElement("span");
    frequency.className = "reminder-frequency-label";
    frequency.textContent = frequencyLabel(reminder.frequency);
    meta.append(timeBadge, frequency);

    const actions = document.createElement("div");
    actions.className = "reminder-actions";
    actions.append(
        reminderButton("Editar", "secondary-button", () => showReminderEditor(card, reminder)),
        reminderButton(reminder.active ? "Desativar" : "Ativar", "secondary-button", () => setReminderActive(reminder, !reminder.active)),
        reminderButton("Excluir", "danger-button", () => deleteReminder(reminder.id, reminder.medicationName))
    );
    card.append(header, meta, actions);
    return card;
}

function showReminderEditor(card, reminder) {
    if (card.querySelector(".reminder-edit-form")) return;

    const form = document.createElement("form");
    form.className = "reminder-edit-form";
    const fields = document.createElement("div");
    fields.className = "reminder-edit-fields";

    const medicationLabel = document.createElement("label");
    medicationLabel.textContent = "Medicamento";
    const medicationInput = document.createElement("select");
    populateMedicationSelect(medicationInput, reminder.medicationId);
    medicationLabel.append(medicationInput);

    const timeLabel = document.createElement("label");
    timeLabel.textContent = "Horário";
    const timeInput = document.createElement("input");
    timeInput.type = "time";
    timeInput.value = reminder.time;
    timeInput.required = true;
    timeLabel.append(timeInput);

    const frequencyLabelElement = document.createElement("label");
    frequencyLabelElement.textContent = "Frequência";
    const frequencyInput = document.createElement("select");
    Object.entries(frequencyLabels).forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = value === reminder.frequency;
        frequencyInput.append(option);
    });
    frequencyLabelElement.append(frequencyInput);

    const activeLabel = document.createElement("label");
    activeLabel.className = "active-field";
    const activeInput = document.createElement("input");
    activeInput.type = "checkbox";
    activeInput.checked = reminder.active;
    activeLabel.append(activeInput, document.createTextNode(" Lembrete ativo"));
    fields.append(medicationLabel, timeLabel, frequencyLabelElement, activeLabel);

    const actions = document.createElement("div");
    actions.className = "edit-actions";
    const saveButton = reminderButton("Salvar alterações", "primary-button", () => {});
    saveButton.type = "submit";
    actions.append(saveButton, reminderButton("Cancelar", "secondary-button", () => form.remove()));
    form.append(fields, actions);

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!medicationInput.value || !timeInput.value) {
            setReminderFeedback("Informe o medicamento e o horário para salvar as alterações.", "error");
            return;
        }
        saveButton.disabled = true;
        setReminderFeedback("");
        try {
            const response = await authenticatedFetch(`/api/reminders/${reminder.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(reminderBody(medicationInput.value, timeInput.value, frequencyInput.value, activeInput.checked))
            });
            if (!response.ok) throw new Error(await reminderError(response, "Não foi possível atualizar o lembrete."));
            setReminderFeedback("Lembrete atualizado com sucesso.", "success");
            await loadReminders();
        } catch (error) {
            setReminderFeedback(error instanceof Error ? error.message : "Não foi possível atualizar o lembrete.", "error");
        } finally {
            saveButton.disabled = false;
        }
    });

    card.append(form);
    medicationInput.focus();
}

function renderReminders(reminders) {
    reminderList.replaceChildren();
    if (!reminders.length) {
        const empty = buildEmptyState(
            "reminder",
            currentMedications.length
                ? "Você ainda não cadastrou lembretes."
                : "Cadastre um medicamento para criar lembretes.",
            currentMedications.length ? "Adicionar lembrete" : "Ir para Medicamentos",
            currentMedications.length
                ? () => reminderMedicationInput.focus()
                : () => setView("medications")
        );
        empty.className = "reminder-state";
        reminderList.append(empty);
        return;
    }
    reminders.forEach((reminder) => reminderList.append(renderReminderCard(reminder)));
}

async function loadReminders() {
    setReminderLoading(true);
    reminderList.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "reminder-state";
    loading.textContent = "Carregando lembretes...";
    reminderList.append(loading);
    try {
        const response = await authenticatedFetch("/api/reminders");
        if (!response.ok) throw new Error(await reminderError(response, "Não foi possível carregar os lembretes."));
        const data = await response.json();
        if (!data || !Array.isArray(data.reminders)) throw new Error("Resposta inesperada ao carregar lembretes.");
        renderReminders(data.reminders);
        notificationScheduler?.setReminders(data.reminders);
        document.querySelector("#frequency-gap").hidden = !data.reminders.some((reminder) => reminder.active && ["weekly", "custom"].includes(reminder.frequency));
        return data.reminders;
    } catch (error) {
        reminderList.replaceChildren();
        notificationScheduler?.setReminders([]);
        const message = document.createElement("p");
        message.className = "reminder-state feedback-error";
        message.textContent = error instanceof Error ? error.message : "Não foi possível carregar os lembretes.";
        reminderList.append(message);
        setReminderFeedback("Verifique sua conexão e tente novamente.", "error");
        return false;
    } finally {
        setReminderLoading(false);
    }
}

const notificationButton = document.querySelector("#notification-toggle");
const notificationStatus = document.querySelector("#notification-status");

function stopReminderNotifications() {
    notificationScheduler?.stop();
    notificationScheduler = null;
    window.clearInterval(reminderRefreshTimer);
    reminderRefreshTimer = null;
}

function stopReminderScheduler() {
    notificationScheduler?.stop();
    notificationScheduler = null;
}

function setNotificationState(state, message) {
    notificationStatus.textContent = message;
    notificationStatus.dataset.state = state;
    notificationButton.disabled = state === "pending" || state === "enabled";
    notificationButton.textContent = state === "enabled" ? "Notificações ativadas" : state === "pending" ? "Aguarde…" : "Ativar notificações";
}

async function enableReminderNotifications() {
    const notification = window.Notification;
    const availability = getNotificationAvailability({ notification, isSecureContext: window.isSecureContext });
    if (availability === "blocked") {
        setNotificationState("blocked", "Notificações bloqueadas ou indisponíveis. Verifique as permissões do navegador e use uma conexão segura.");
        return;
    }

    setNotificationState("pending", "Aguardando permissão para mostrar notificações…");
    let permission;
    try {
        permission = notification.permission === "granted" ? "granted" : await notification.requestPermission();
    } catch {
        setNotificationState("blocked", "Não foi possível solicitar permissão para notificações neste navegador.");
        return;
    }
    if (permission !== "granted") {
        setNotificationState("blocked", permission === "denied"
            ? "Permissão negada. Altere a permissão de notificações nas configurações do navegador para ativar."
            : "Permissão não concedida. As notificações continuam desativadas.");
        return;
    }

    try {
        const reminders = await loadReminders();
        if (!Array.isArray(reminders)) throw new Error("reminders-load-failed");
        initializeReminderScheduler(reminders);
    } catch {
        notificationScheduler?.stop();
        notificationScheduler = null;
        setNotificationState("disabled", "Não foi possível carregar seus lembretes. Verifique a conexão e tente ativar novamente.");
    }
}

function initializeReminderScheduler(reminders) {
    const availability = getNotificationAvailability({ notification: window.Notification, isSecureContext: window.isSecureContext });
    if (availability !== "enabled") {
        stopReminderScheduler();
        updateNotificationPermissionState();
        return null;
    }
    if (!Number.isSafeInteger(currentAuthUserId) || currentAuthUserId <= 0) return null;
    notificationScheduler = startReminderSchedulerIfAllowed({
        scheduler: notificationScheduler,
        userId: currentAuthUserId,
        notification: window.Notification,
        isSecureContext: window.isSecureContext,
        storage: window.localStorage,
        reminders,
        onNavigate: () => setView("reminders")
    });
    if (notificationScheduler) {
        setNotificationState("enabled", "Notificações ativadas. O navegador precisa manter esta página ativa para verificar os horários.");
    }
    return notificationScheduler;
}

async function refreshReminderNotifications() {
    const availability = getNotificationAvailability({ notification: window.Notification, isSecureContext: window.isSecureContext });
    if (availability === "blocked") {
        stopReminderScheduler();
        updateNotificationPermissionState();
        return;
    }
    if (availability !== "enabled") {
        stopReminderScheduler();
        updateNotificationPermissionState();
        return;
    }
    const reminders = await loadReminders();
    if (!Array.isArray(reminders)) return;
    if (!notificationScheduler) initializeReminderScheduler(reminders);
    else if (document.visibilityState === "visible") notificationScheduler.handleVisibilityChange(true);
}

function updateNotificationPermissionState() {
    const availability = getNotificationAvailability({ notification: window.Notification, isSecureContext: window.isSecureContext });
    if (availability === "blocked") {
        setNotificationState("blocked", !window.isSecureContext
            ? "Notificações exigem uma conexão segura (HTTPS ou localhost)."
            : window.Notification?.permission === "denied"
                ? "Permissão negada. Altere a permissão nas configurações do navegador."
                : "Este navegador não oferece notificações ou a permissão está bloqueada.");
    } else if (availability === "enabled") {
        setNotificationState("disabled", "A permissão foi concedida. Entre na conta para retomar as notificações.");
    } else {
        setNotificationState("disabled", "Notificações desativadas. Clique para solicitar permissão e ativá-las neste navegador.");
    }
}

notificationButton.addEventListener("click", () => {
    if (notificationScheduler || notificationButton.disabled) return;
    enableReminderNotifications();
});

updateNotificationPermissionState();

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
        notificationScheduler?.handleVisibilityChange(false);
        return;
    }
    if (!Number.isSafeInteger(currentAuthUserId)) return;
    const availability = getNotificationAvailability({ notification: window.Notification, isSecureContext: window.isSecureContext });
    if (availability !== "enabled") {
        stopReminderScheduler();
        updateNotificationPermissionState();
        return;
    }
    loadReminders().then((reminders) => {
        if (!Array.isArray(reminders)) return;
        initializeReminderScheduler(reminders);
        notificationScheduler?.handleVisibilityChange(true);
    });
});

async function setReminderActive(reminder, active) {
    setReminderFeedback("");
    try {
        const response = await authenticatedFetch(`/api/reminders/${reminder.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active })
        });
        if (!response.ok) throw new Error(await reminderError(response, "Não foi possível atualizar o lembrete."));
        setReminderFeedback(`Lembrete ${active ? "ativado" : "desativado"} com sucesso.`, "success");
        await loadReminders();
    } catch (error) {
        setReminderFeedback(error instanceof Error ? error.message : "Não foi possível atualizar o lembrete.", "error");
    }
}

async function deleteReminder(id, medicationName) {
    if (!window.confirm(`Excluir o lembrete de "${medicationName}"?`)) return;
    setReminderFeedback("");
    try {
        const response = await authenticatedFetch(`/api/reminders/${id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(await reminderError(response, "Não foi possível excluir o lembrete."));
        setReminderFeedback("Lembrete excluído com sucesso.", "success");
        await loadReminders();
    } catch (error) {
        setReminderFeedback(error instanceof Error ? error.message : "Não foi possível excluir o lembrete.", "error");
    }
}

reminderForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const medicationId = reminderMedicationInput.value;
    const time = reminderTimeInput.value;
    reminderMedicationInput.classList.toggle("input-error", !medicationId);
    reminderTimeInput.classList.toggle("input-error", !time);
    if (!medicationId || !time) {
        setReminderFeedback("Informe o medicamento e o horário para adicionar o lembrete.", "error");
        return;
    }

    setReminderLoading(true);
    setReminderFeedback("");
    try {
        const response = await authenticatedFetch("/api/reminders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reminderBody(medicationId, time, reminderFrequencyInput.value, reminderActiveInput.checked))
        });
        if (!response.ok) throw new Error(await reminderError(response, "Não foi possível adicionar o lembrete."));
        reminderForm.reset();
        reminderActiveInput.checked = true;
        setReminderFeedback("Lembrete adicionado com sucesso.", "success");
        await loadReminders();
        reminderMedicationInput.focus();
    } catch (error) {
        setReminderFeedback(error instanceof Error ? error.message : "Não foi possível adicionar o lembrete.", "error");
    } finally {
        setReminderLoading(false);
    }
});

const telegramStatus = document.querySelector("#telegram-status");
const telegramCodeBox = document.querySelector("#telegram-code-box");
const telegramCodeValue = document.querySelector("#telegram-code-value");
const telegramCopyButton = document.querySelector("#telegram-copy-button");
const telegramRefreshButton = document.querySelector("#telegram-refresh-button");
const telegramOpenLink = document.querySelector("#telegram-open-link");
const telegramConnectButton = document.querySelector("#telegram-connect-button");
const telegramDisconnectButton = document.querySelector("#telegram-disconnect-button");

function renderTelegramLinked(linked) {
    telegramStatus.dataset.state = linked ? "linked" : "";
    telegramStatus.textContent = linked
        ? "Telegram conectado. Você já pode enviar perguntas sobre bulas pelo bot."
        : "Vincule sua conta para consultar bulas também pelo Telegram.";
    telegramConnectButton.hidden = linked;
    telegramDisconnectButton.hidden = !linked;
    if (linked) {
        telegramCodeBox.hidden = true;
        telegramOpenLink.hidden = true;
    }
}

async function generateTelegramLinkCode() {
    telegramConnectButton.disabled = true;
    try {
        const response = await authenticatedFetch("/api/telegram/link-code", { method: "POST" });
        if (!response.ok) throw new Error(await readError(response, "Não foi possível gerar o código de vínculo."));
        const data = await response.json();
        if (!data || typeof data.code !== "string" || typeof data.telegramLink !== "string") {
            throw new Error("Resposta inesperada ao gerar o código de vínculo.");
        }
        telegramCodeValue.textContent = data.code;
        telegramCodeBox.hidden = false;
        telegramOpenLink.href = data.telegramLink;
        telegramOpenLink.hidden = false;
        telegramStatus.textContent = "Envie esse código para o bot no Telegram (ou abra o link) para concluir o vínculo.";
    } catch (error) {
        telegramStatus.textContent = error instanceof Error ? error.message : "Não foi possível gerar o código de vínculo.";
    } finally {
        telegramConnectButton.disabled = false;
    }
}

async function copyTelegramCode() {
    const code = telegramCodeValue.textContent || "";
    if (!code) return;
    try {
        await navigator.clipboard.writeText(code);
        telegramCopyButton.textContent = "Copiado!";
    } catch {
        telegramCopyButton.textContent = "Não foi possível copiar";
    } finally {
        window.setTimeout(() => { telegramCopyButton.textContent = "Copiar"; }, 2000);
    }
}

async function refreshTelegramLinkStatus() {
    try {
        const response = await authenticatedFetch("/api/auth/me");
        if (!response.ok) throw new Error("request-failed");
        const data = await response.json();
        renderTelegramLinked(Boolean(data?.user?.telegramLinked));
    } catch {
        telegramStatus.textContent = "Não foi possível verificar o status do vínculo. Tente novamente.";
    }
}

async function disconnectTelegram() {
    if (!window.confirm("Desvincular o Telegram desta conta?")) return;
    telegramDisconnectButton.disabled = true;
    try {
        const response = await authenticatedFetch("/api/telegram/link", { method: "DELETE" });
        if (!response.ok) throw new Error(await readError(response, "Não foi possível desvincular o Telegram."));
        renderTelegramLinked(false);
    } catch (error) {
        telegramStatus.textContent = error instanceof Error ? error.message : "Não foi possível desvincular o Telegram.";
    } finally {
        telegramDisconnectButton.disabled = false;
    }
}

telegramConnectButton.addEventListener("click", generateTelegramLinkCode);
telegramCopyButton.addEventListener("click", copyTelegramCode);
telegramRefreshButton.addEventListener("click", refreshTelegramLinkStatus);
telegramDisconnectButton.addEventListener("click", disconnectTelegram);

function formatHistoryDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? "Data não disponível"
        : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function showHistoryDetail(query) {
    historyDetail.replaceChildren();
    const title = document.createElement("h3");
    title.textContent = "Sua pergunta";
    const question = document.createElement("p");
    question.textContent = query.question;
    const answerTitle = document.createElement("h3");
    answerTitle.textContent = "Resposta do MediBot";
    const answer = document.createElement("div");
    answer.className = "markdown-content";
    renderMarkdown(answer, query.answer);
    historyDetail.append(title, question, answerTitle, answer);

    const sources = Array.isArray(query.sources) ? query.sources.filter((source) => typeof source === "string" && source.trim()) : [];
    if (sources.length) {
        const source = document.createElement("p");
        source.className = "message-source";
        source.textContent = `Fonte${sources.length > 1 ? "s" : ""}: ${sources.join(", ")}`;
        historyDetail.append(source);
    }
}

let historyDetailRequestId = 0;

async function loadQueryDetail(id) {
    const requestId = ++historyDetailRequestId;
    try {
        const response = await authenticatedFetch(`/api/queries/${id}`);
        if (!response.ok) throw new Error(await readError(response, "Não foi possível carregar esta consulta."));
        const data = await response.json();
        if (!data || !data.query) throw new Error("Resposta inesperada ao carregar a consulta.");
        if (requestId !== historyDetailRequestId) return;
        showHistoryDetail(data.query);
    } catch (error) {
        if (requestId !== historyDetailRequestId) return;
        historyDetail.replaceChildren();
        const message = document.createElement("p");
        message.className = "history-state";
        message.textContent = error instanceof Error ? error.message : "Não foi possível carregar esta consulta.";
        historyDetail.append(message);
    }
}

let historyListRequestId = 0;

async function loadQueryHistory() {
    const requestId = ++historyListRequestId;
    historyList.setAttribute("aria-busy", "true");
    try {
        const response = await authenticatedFetch("/api/queries");
        if (!response.ok) throw new Error(await readError(response, "Não foi possível carregar o histórico."));
        const data = await response.json();
        if (!data || !Array.isArray(data.queries)) throw new Error("Resposta inesperada ao carregar o histórico.");

        if (requestId !== historyListRequestId) return;
        historyList.replaceChildren();

        if (!data.queries.length) {
            const empty = buildEmptyState(
                "history",
                "Suas consultas aparecerão aqui.",
                "Fazer uma pergunta",
                () => {
                    setView("chat");
                    questionInput.focus();
                }
            );
            empty.className = "history-state";
            historyList.append(empty);
            return;
        }

        data.queries.forEach((query, index) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "history-item";
            const question = document.createElement("span");
            question.className = "history-question";
            question.textContent = query.question;
            item.title = query.question;
            const date = document.createElement("span");
            date.className = "history-date";
            date.textContent = formatHistoryDate(query.createdAt || query.created_at);
            item.append(question, date);
            item.addEventListener("click", () => {
                historyList.querySelectorAll(".history-item").forEach((button) => button.classList.remove("active"));
                item.classList.add("active");
                loadQueryDetail(query.id);
            });
            historyList.append(item);
            if (index === 0) {
                item.classList.add("active");
                loadQueryDetail(query.id);
            }
        });
    } catch (error) {
        if (requestId !== historyListRequestId) return;
        historyList.replaceChildren();
        const message = document.createElement("p");
        message.className = "history-state feedback-error";
        message.textContent = error instanceof Error ? error.message : "Não foi possível carregar o histórico.";
        historyList.append(message);
    } finally {
        if (requestId === historyListRequestId) {
            historyList.setAttribute("aria-busy", "false");
        }
    }
}

function setView(view) {
    document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    document.querySelector(".chat-panel").hidden = view !== "chat";
    document.querySelector(".history-panel").hidden = view !== "history";
    document.querySelector(".medications-panel").hidden = view !== "medications";
    document.querySelector(".reminders-panel").hidden = view !== "reminders";
    document.querySelector(".safety-note").hidden = view !== "chat";
    document.querySelector("#sidebar").classList.remove("mobile-open");
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    setView(button.dataset.view);
    if (button.dataset.view === "history") loadQueryHistory();
}));
document.querySelector("#new-chat-button").addEventListener("click", () => {
    messages.replaceChildren();
    document.querySelector(".suggestions").hidden = false;
    feedback.textContent = "";
    addMessage("Olá! Eu sou o MediBot. Posso ajudar você a compreender informações presentes nas bulas dos medicamentos disponíveis no sistema. Faça uma pergunta sobre um medicamento.", "bot");
    setView("chat");
    questionInput.focus();
});
const sidebar = document.querySelector("#sidebar");
const sidebarToggle = document.querySelector("#sidebar-toggle");
sidebarToggle.setAttribute("aria-expanded", "true");
sidebarToggle.addEventListener("click", () => {
    const collapsed = sidebar.classList.toggle("collapsed");
    sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    sidebarToggle.setAttribute("aria-label", collapsed ? "Expandir menu" : "Recolher menu");
});
document.querySelector("#mobile-menu").addEventListener("click", () => document.querySelector("#sidebar").classList.toggle("mobile-open"));

document.querySelector("#show-register").addEventListener("click", showRegister);
document.querySelector("#show-login").addEventListener("click", () => showLogin());

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const identifier = document.querySelector("#login-identifier").value.trim();
    const password = document.querySelector("#login-password").value;
    loginFeedback.textContent = "";
    try {
        const response = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier, password })
        });
        if (!response.ok) throw new Error(await readError(response, "Não foi possível entrar."));
        const data = await response.json();
        if (!data?.token || !data?.user) throw new Error("Resposta inesperada ao entrar.");
        window.localStorage.setItem(authTokenStorageKey, data.token);
        loginForm.reset();
        showApplication(data.user);
    } catch (error) {
        loginFeedback.textContent = error instanceof Error ? error.message : "Não foi possível entrar.";
    }
});

registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.querySelector("#register-name").value.trim();
    const email = document.querySelector("#register-email").value.trim();
    const phone = document.querySelector("#register-phone").value.trim();
    const password = document.querySelector("#register-password").value;
    registerFeedback.textContent = "";

    if (!email && !phone) {
        registerFeedback.textContent = "Informe pelo menos um: e-mail ou telefone.";
        return;
    }

    try {
        const response = await fetch("/api/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, email, phone, password })
        });
        if (!response.ok) throw new Error(await readError(response, "Não foi possível criar a conta."));
        registerForm.reset();
        showLogin("Conta criada com sucesso. Agora entre com seu e-mail ou telefone e senha.", true);
    } catch (error) {
        registerFeedback.textContent = error instanceof Error ? error.message : "Não foi possível criar a conta.";
    }
});

document.querySelector("#logout-button").addEventListener("click", () => showAuthentication());

async function initializeApplication() {
    const token = getAuthToken();
    if (!token) {
        showLogin();
        return;
    }

    try {
        const response = await authenticatedFetch("/api/auth/me");
        if (!response.ok) throw new Error("invalid-token");
        const data = await response.json();
        if (!data?.user) throw new Error("invalid-token");
        showApplication(data.user);
    } catch {
        showAuthentication();
    }
}

initializeApplication();
