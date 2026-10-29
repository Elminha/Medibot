import {
    DEFAULT_REMINDER_TIME_ZONE,
    getNextOccurrence,
    getTimezoneParts,
    startReminderSchedulerIfAllowed
} from "./reminderNotifications.js";
import {
    computeEndsOn,
    countDaysInclusive,
    generateEvenlySpacedTimes,
    generateIntervalTimes,
    MAX_TIMES_PER_REMINDER,
    recalculateIntervalTimes,
    summarizeReminder,
    summarizeSchedule
} from "./reminderWizard.js";
import {
    formatCountdown,
    getCountdownLevel,
    getRemainingMs,
    isCountdownExpired,
    parseStoredLinkCode,
    TelegramLinkCountdownTimer
} from "./telegramLinkCountdown.js";

// Lê e remove o token de "#redefinir=<token>" da URL antes de qualquer outro código
// (tema, consentimento de cookies/GA, bootstrap de login). O token nunca é guardado em
// localStorage/sessionStorage, em atributos do DOM, em eventos do GA ou em logs — fica
// só nesta variável, em memória, enquanto a página estiver aberta.
let pendingPasswordResetToken = null;
(function consumePasswordResetTokenFromHash() {
    const match = /^#redefinir=(.+)$/.exec(window.location.hash);
    if (!match) return;
    pendingPasswordResetToken = decodeURIComponent(match[1]);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
})();

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
const forgotPasswordPanel = document.querySelector("#forgot-password-panel");
const resetPasswordPanel = document.querySelector("#reset-password-panel");
const forgotPasswordForm = document.querySelector("#forgot-password-form");
const resetPasswordForm = document.querySelector("#reset-password-form");
const forgotPasswordFeedback = document.querySelector("#forgot-password-feedback");
const resetPasswordFeedback = document.querySelector("#reset-password-feedback");
const resetPasswordRequestNew = document.querySelector("#reset-password-request-new");
const loggedUser = document.querySelector("#logged-user");
const userAvatar = document.querySelector(".user-avatar");
const historyList = document.querySelector("#history-list");
const historyDetail = document.querySelector("#history-detail");
const historyFeedback = document.querySelector("#history-feedback");

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
    const next = current === "dark" ? "light" : "dark";
    setTheme(next);
    track("theme_change", { theme: next === "dark" ? "escuro" : "claro" });
});

// ===== Google Analytics (consentimento obrigatório) =====
const GA_MEASUREMENT_ID = "G-8RZ35N1DTJ";
const cookieConsentStorageKey = "medibot_cookie_consent";
const cookieBanner = document.querySelector("#cookie-banner");
const cookieBannerHint = document.querySelector("#cookie-banner-hint");
const cookieAcceptButton = document.querySelector("#cookie-accept");
const cookieRejectButton = document.querySelector("#cookie-reject");
const privacyCookiesLink = document.querySelector("#privacy-cookies-link");
const viewPageMeta = {
    chat: { title: "Conversar", path: "/conversar" },
    history: { title: "Histórico", path: "/historico" },
    medications: { title: "Medicamentos", path: "/medicamentos" },
    reminders: { title: "Lembretes", path: "/lembretes" }
};
let gaActive = false;
let activeView = "chat";

function getStoredConsent() {
    try {
        const value = window.localStorage.getItem(cookieConsentStorageKey);
        return value === "accepted" || value === "rejected" ? value : null;
    } catch {
        return null;
    }
}

function storeConsent(value) {
    try {
        window.localStorage.setItem(cookieConsentStorageKey, value);
    } catch {
        // ignore storage access errors
    }
}

function loadGoogleAnalytics() {
    if (gaActive) return;
    gaActive = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", GA_MEASUREMENT_ID, { send_page_view: false, anonymize_ip: true });
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    document.head.append(script);
    if (!authenticatedApp.hidden) trackPageView(activeView);
}

function track(eventName, params = {}) {
    if (!gaActive || typeof window.gtag !== "function") return;
    window.gtag("event", eventName, params);
}

function trackPageView(view) {
    const meta = viewPageMeta[view];
    if (!meta || !gaActive || typeof window.gtag !== "function") return;
    window.gtag("event", "page_view", {
        page_title: meta.title,
        page_location: `${window.location.origin}${meta.path}`,
        page_path: meta.path
    });
}

function hideCookieBanner() {
    if (cookieBanner) cookieBanner.hidden = true;
}

function showCookieBanner() {
    if (cookieBanner) cookieBanner.hidden = false;
}

function initCookieConsent() {
    const stored = getStoredConsent();
    if (stored === "accepted") {
        loadGoogleAnalytics();
        hideCookieBanner();
    } else if (stored === "rejected") {
        hideCookieBanner();
    } else {
        showCookieBanner();
    }
}

cookieAcceptButton?.addEventListener("click", () => {
    storeConsent("accepted");
    hideCookieBanner();
    loadGoogleAnalytics();
});

cookieRejectButton?.addEventListener("click", () => {
    const hadAccepted = getStoredConsent() === "accepted";
    storeConsent("rejected");
    gaActive = false;
    hideCookieBanner();
    if (hadAccepted) window.location.reload();
});

privacyCookiesLink?.addEventListener("click", (event) => {
    event.preventDefault();
    if (cookieBannerHint) cookieBannerHint.hidden = getStoredConsent() !== "accepted";
    showCookieBanner();
});

initCookieConsent();

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

// ===== Toast (feedback de sucesso que não fica preso dentro de um formulário) =====

const toastContainer = document.querySelector("#toast-container");

function showToast(message, type = "success", durationMs = 4000) {
    const toast = document.createElement("p");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.append(toast);
    window.requestAnimationFrame(() => toast.classList.add("toast-visible"));
    window.setTimeout(() => {
        toast.classList.remove("toast-visible");
        window.setTimeout(() => toast.remove(), 250);
    }, durationMs);
}

// ===== Diálogo de confirmação (substitui window.confirm) =====

const confirmDialogBackdrop = document.querySelector("#confirm-dialog-backdrop");
const confirmDialogTitle = document.querySelector("#confirm-dialog-title");
const confirmDialogMessage = document.querySelector("#confirm-dialog-message");
const confirmDialogCancelButton = document.querySelector("#confirm-dialog-cancel");
const confirmDialogConfirmButton = document.querySelector("#confirm-dialog-confirm");

function confirmDialog(message, { title = "Confirmar", confirmLabel = "Excluir" } = {}) {
    return new Promise((resolve) => {
        const previouslyFocused = document.activeElement;
        confirmDialogTitle.textContent = title;
        confirmDialogMessage.textContent = message;
        confirmDialogConfirmButton.textContent = confirmLabel;
        confirmDialogBackdrop.hidden = false;
        confirmDialogConfirmButton.focus();

        function close(result) {
            confirmDialogBackdrop.hidden = true;
            document.removeEventListener("keydown", onKeyDown);
            confirmDialogConfirmButton.removeEventListener("click", onConfirm);
            confirmDialogCancelButton.removeEventListener("click", onCancel);
            confirmDialogBackdrop.removeEventListener("click", onBackdropClick);
            if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
            resolve(result);
        }

        function onConfirm() { close(true); }
        function onCancel() { close(false); }
        function onKeyDown(event) { if (event.key === "Escape") close(false); }
        function onBackdropClick(event) { if (event.target === confirmDialogBackdrop) close(false); }

        confirmDialogConfirmButton.addEventListener("click", onConfirm);
        confirmDialogCancelButton.addEventListener("click", onCancel);
        document.addEventListener("keydown", onKeyDown);
        confirmDialogBackdrop.addEventListener("click", onBackdropClick);
    });
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
    // Dados do usuário autenticado nunca devem vir do cache HTTP do navegador (o
    // servidor já manda Cache-Control: no-store, isto é defesa adicional do lado do cliente).
    const response = await fetch(url, { ...options, headers, cache: "no-store" });

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
    forgotPasswordPanel.hidden = true;
    resetPasswordPanel.hidden = true;
    loginFeedback.textContent = message;
    loginFeedback.classList.toggle("success", success);
}

function showRegister() {
    loginPanel.hidden = true;
    registerPanel.hidden = false;
    forgotPasswordPanel.hidden = true;
    resetPasswordPanel.hidden = true;
    loginFeedback.textContent = "";
    registerFeedback.textContent = "";
    registerFeedback.classList.remove("success");
    document.querySelector("#register-name").focus();
}

function showForgotPassword() {
    loginPanel.hidden = true;
    registerPanel.hidden = true;
    forgotPasswordPanel.hidden = false;
    resetPasswordPanel.hidden = true;
    loginFeedback.textContent = "";
    forgotPasswordFeedback.textContent = "";
    forgotPasswordFeedback.classList.remove("success");
    document.querySelector("#forgot-password-email").focus();
}

function showResetPassword() {
    authView.hidden = false;
    authenticatedApp.hidden = true;
    loginPanel.hidden = true;
    registerPanel.hidden = true;
    forgotPasswordPanel.hidden = true;
    resetPasswordPanel.hidden = false;
    resetPasswordFeedback.textContent = "";
    resetPasswordFeedback.classList.remove("success");
    resetPasswordRequestNew.hidden = true;
    document.querySelector("#reset-password-password").focus();
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
    showHistoryEmptyDetail();
    if (historyFeedback) historyFeedback.textContent = "";
    renderTelegramLinked(false);
    telegramCountdown.stop();
    clearStoredTelegramLinkCode();
    telegramCodeBox.hidden = true;
    telegramOpenLink.hidden = true;
    currentTelegramLink = null;
    questionInput.value = "";
    medicationForm.reset();
    resetReminderWizard();
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
    if (!user.telegramLinked) restoreTelegramCodeFromStorage();
    const notificationAlreadyGranted = permissionKind() === "granted";
    renderNotificationCard();

    const reminderLoad = notificationAlreadyGranted ? loadReminderDataForScheduler() : loadReminders();
    // try/catch (não só .then) garante que o card de notificações nunca fique preso:
    // qualquer falha, mesmo inesperada, cai no catch e devolve um estado clicável de
    // novo ("Tentar novamente"), em vez de ficar travado num texto de carregamento.
    Promise.all([loadMedications(), reminderLoad, loadQueryHistory()])
        .catch((error) => {
            console.error("Falha inesperada ao preparar a tela inicial:", error);
            if (notificationAlreadyGranted) {
                reminderLoadState = "error";
                renderNotificationCard();
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
    track("ask_question");
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
const reminderWizardTitle = document.querySelector("#reminder-wizard-title");
const reminderWizardForm = document.querySelector("#reminder-wizard-form");
const wizardMedicationInput = document.querySelector("#wizard-medication");
const wizardFrequencyOptions = document.querySelector("#wizard-frequency-options");
const wizardChooseTimesButton = document.querySelector("#wizard-choose-times-button");
const wizardTimeList = document.querySelector("#wizard-time-list");
const wizardAddTimeButton = document.querySelector("#wizard-add-time-button");
const wizardIntervalHint = document.querySelector("#wizard-interval-hint");
const wizardDayModeOptions = document.querySelector("#wizard-day-mode-options");
const wizardWeekdayList = document.querySelector("#wizard-weekday-list");
const wizardDurationModeOptions = document.querySelector("#wizard-duration-mode-options");
const wizardDurationFields = document.querySelector("#wizard-duration-fields");
const wizardDurationDaysInput = document.querySelector("#wizard-duration-days");
const wizardStartsOnInput = document.querySelector("#wizard-starts-on");
const wizardSummary = document.querySelector("#wizard-summary");
const reminderFeedback = document.querySelector("#reminder-feedback");
const reminderList = document.querySelector("#reminder-list");
const wizardSaveButton = document.querySelector("#wizard-save-button");
const wizardCancelButton = document.querySelector("#wizard-cancel-button");
const REMINDER_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
let currentMedications = [];
let currentReminderTimezone = DEFAULT_REMINDER_TIME_ZONE;
let editingReminderId = null;
let wizardTimes = [];
let wizardIntervalHours = null; // 6 | 8 | 12 quando os horários vieram de "de X em X horas"; null nos outros modos
let wizardDayMode = "all";
let wizardWeekdays = [];
let wizardDurationMode = "forever";

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
    const confirmed = await confirmDialog(`Excluir o medicamento "${name}"? Os lembretes associados a ele também serão excluídos.`, {
        title: "Excluir medicamento"
    });
    if (!confirmed) return;
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
        track("medication_added");
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
    wizardSaveButton.disabled = isLoading || currentMedications.length === 0;
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
    const selectedId = wizardMedicationInput.value;
    populateMedicationSelect(wizardMedicationInput, selectedId);
    wizardSaveButton.disabled = currentMedications.length === 0;
}

function reminderButton(text, className, onClick) {
    return medicationButton(text, className, onClick);
}

function statusLabel(status) {
    return status === "ended" ? "Encerrado" : status === "paused" ? "Pausado" : "Ativo";
}

function renderReminderCard(reminder) {
    const card = document.createElement("article");
    card.className = "reminder-card";
    card.dataset.reminderId = String(reminder.id);
    const header = document.createElement("div");
    header.className = "reminder-card-header";
    const name = document.createElement("h3");
    name.className = "reminder-medication-name";
    name.textContent = reminder.medicationName;
    const status = document.createElement("span");
    status.className = `reminder-status${reminder.status === "active" ? "" : ` ${reminder.status}`}`;
    status.textContent = statusLabel(reminder.status);
    header.append(name, status);

    const summary = document.createElement("p");
    summary.className = "reminder-frequency-label";
    summary.textContent = summarizeSchedule(reminder);

    const actions = document.createElement("div");
    actions.className = "reminder-actions";
    actions.append(
        reminderButton("Editar", "secondary-button", () => fillWizardForEdit(reminder)),
        reminderButton(reminder.active ? "Pausar" : "Ativar", "secondary-button", () => setReminderActive(reminder, !reminder.active)),
        reminderButton("Excluir", "danger-button", () => deleteReminder(reminder.id, reminder.medicationName))
    );
    card.append(header, summary, actions);
    return card;
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
                ? () => wizardMedicationInput.focus()
                : () => setView("medications")
        );
        empty.className = "reminder-state";
        reminderList.append(empty);
        return;
    }
    reminders.forEach((reminder) => reminderList.append(renderReminderCard(reminder)));
}

function highlightReminderCard(id) {
    const card = reminderList.querySelector(`[data-reminder-id="${id}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("reminder-card-highlight");
    window.setTimeout(() => card.classList.remove("reminder-card-highlight"), 1500);
}

const REMINDERS_FETCH_TIMEOUT_MS = 15_000;

async function fetchRemindersOnce() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REMINDERS_FETCH_TIMEOUT_MS);
    try {
        const response = await authenticatedFetch("/api/reminders", { signal: controller.signal });
        if (!response.ok) throw new Error(await reminderError(response, "Não foi possível carregar os lembretes."));
        const data = await response.json();
        if (!data || !Array.isArray(data.reminders)) throw new Error("Resposta inesperada ao carregar lembretes.");
        return data;
    } finally {
        window.clearTimeout(timeout);
    }
}

/**
 * Nunca deixa o estado de carregamento preso: uma tentativa, mais uma repetição
 * automática antes de mostrar erro com "Tentar novamente" — e uma lista vazia de
 * verdade (0 lembretes, requisição ok) é sempre o estado vazio normal, nunca um erro.
 */
async function loadReminders() {
    setReminderLoading(true);
    reminderList.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "reminder-state";
    loading.textContent = "Carregando lembretes...";
    reminderList.append(loading);

    try {
        let data;
        try {
            data = await fetchRemindersOnce();
        } catch (firstError) {
            console.error("Falha ao carregar lembretes (tentando de novo):", firstError);
            data = await fetchRemindersOnce();
        }

        renderReminders(data.reminders);
        currentReminderTimezone = data.timezone || DEFAULT_REMINDER_TIME_ZONE;
        currentReminders = data.reminders;
        notificationScheduler?.setReminders(data.reminders);
        updateNextReminderLine();
        return data.reminders;
    } catch (error) {
        console.error("Falha ao carregar lembretes:", error);
        reminderList.replaceChildren();
        notificationScheduler?.setReminders([]);
        const message = document.createElement("p");
        message.className = "reminder-state feedback-error";
        message.textContent = "Não foi possível carregar seus lembretes agora.";
        message.append(document.createElement("br"), reminderButton("Tentar novamente", "secondary-button", () => loadReminders()));
        reminderList.append(message);
        setReminderFeedback("Verifique sua conexão e tente novamente.", "error");
        return false;
    } finally {
        setReminderLoading(false);
    }
}

const notificationButton = document.querySelector("#notification-toggle");
const notificationStatus = document.querySelector("#notification-status");
const notificationCard = document.querySelector("#notification-card");
const notificationNext = document.querySelector("#notification-next");
const notificationTestButton = document.querySelector("#notification-test-button");

// Carregamento (requisição) e permissão são dois eixos independentes: a permissão
// pode estar concedida e, ainda assim, o carregamento dos lembretes falhar (e
// vice-versa). Misturar os dois numa única mensagem foi a causa do card "preso".
let reminderLoadState = "idle"; // idle | loading | loaded | error
let currentReminders = [];

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

function permissionKind() {
    if (!window.isSecureContext) return "insecure";
    if (!window.Notification || typeof window.Notification.requestPermission !== "function") return "unsupported";
    if (window.Notification.permission === "denied") return "denied";
    if (window.Notification.permission === "granted") return "granted";
    return "default";
}

/** "02:59", "amanhã 02:59" ou "05/11 02:59", segundo a distância em dias de calendário. */
function formatNextOccurrenceLabel(next, timezone) {
    const todayKey = getTimezoneParts(new Date(), timezone).dateKey;
    const occurrenceKey = getTimezoneParts(new Date(next.at), timezone).dateKey;
    if (occurrenceKey === todayKey) return next.time;
    const tomorrowKey = getTimezoneParts(new Date(Date.now() + 86_400_000), timezone).dateKey;
    if (occurrenceKey === tomorrowKey) return `amanhã ${next.time}`;
    const [, month, day] = occurrenceKey.split("-");
    return `${day}/${month} ${next.time}`;
}

function updateNextReminderLine() {
    const next = permissionKind() === "granted" && reminderLoadState === "loaded"
        ? getNextOccurrence(currentReminders, new Date(), currentReminderTimezone)
        : null;
    notificationNext.hidden = !next;
    if (next) {
        notificationNext.textContent = `Próximo lembrete: ${formatNextOccurrenceLabel(next, currentReminderTimezone)} (${next.medicationName})`;
    }
}

/** Única função que escreve no card: estado sempre consistente, nunca "preso". */
function renderNotificationCard() {
    const kind = permissionKind();
    const active = kind === "granted" && reminderLoadState === "loaded";
    notificationCard.classList.toggle("compact", active);
    notificationTestButton.hidden = !active;

    if (kind === "insecure") {
        notificationButton.hidden = false;
        notificationButton.disabled = true;
        notificationButton.textContent = "Ativar notificações";
        notificationStatus.textContent = "Notificações exigem uma conexão segura (HTTPS ou localhost).";
    } else if (kind === "unsupported") {
        notificationButton.hidden = false;
        notificationButton.disabled = true;
        notificationButton.textContent = "Ativar notificações";
        notificationStatus.textContent = "Este navegador não oferece notificações.";
    } else if (kind === "denied") {
        notificationButton.hidden = true;
        notificationStatus.textContent = "Permissão negada. Para ativar, clique no ícone ao lado do endereço do site e permita notificações.";
    } else if (kind === "default") {
        notificationButton.hidden = false;
        notificationButton.disabled = false;
        notificationButton.textContent = "Ativar notificações";
        notificationStatus.textContent = "Notificações desativadas. Ative para receber avisos neste navegador.";
    } else if (reminderLoadState === "loading") {
        notificationButton.hidden = true;
        notificationStatus.textContent = "Permissão concedida. Carregando seus lembretes…";
    } else if (reminderLoadState === "error") {
        notificationButton.hidden = false;
        notificationButton.disabled = false;
        notificationButton.textContent = "Tentar novamente";
        notificationStatus.textContent = "Permissão concedida, mas não foi possível iniciar as notificações agora.";
    } else if (reminderLoadState === "loaded") {
        notificationButton.hidden = true;
        notificationStatus.textContent = "Notificações ativas";
    } else {
        // "idle": permissão já concedida (de uma visita anterior), mas ainda não
        // tentamos carregar os lembretes agora (ex.: antes do login terminar).
        notificationButton.hidden = true;
        notificationStatus.textContent = "Permissão concedida.";
    }
    updateNextReminderLine();
}

async function loadReminderDataForScheduler() {
    reminderLoadState = "loading";
    renderNotificationCard();
    try {
        const reminders = await loadReminders();
        if (!Array.isArray(reminders)) throw new Error("reminders-load-failed");
        initializeReminderScheduler(reminders);
        reminderLoadState = "loaded";
    } catch (error) {
        console.error("Falha ao iniciar notificações de lembretes:", error);
        stopReminderScheduler();
        reminderLoadState = "error";
    } finally {
        renderNotificationCard();
    }
}

async function requestNotificationPermissionAndLoad() {
    if (permissionKind() !== "default") {
        renderNotificationCard();
        return;
    }
    let permission;
    try {
        permission = await window.Notification.requestPermission();
    } catch (error) {
        console.error("Não foi possível solicitar permissão de notificação:", error);
        renderNotificationCard();
        return;
    }
    renderNotificationCard();
    if (permission === "granted") await loadReminderDataForScheduler();
}

function initializeReminderScheduler(reminders) {
    if (permissionKind() !== "granted" || !Number.isSafeInteger(currentAuthUserId) || currentAuthUserId <= 0) {
        stopReminderScheduler();
        return null;
    }
    notificationScheduler = startReminderSchedulerIfAllowed({
        scheduler: notificationScheduler,
        userId: currentAuthUserId,
        timezone: currentReminderTimezone,
        notification: window.Notification,
        isSecureContext: window.isSecureContext,
        storage: window.localStorage,
        reminders,
        onNavigate: () => setView("reminders")
    });
    return notificationScheduler;
}

/** Atualiza só os dados usados pelo agendador/"próximo lembrete", sem redesenhar a
 * lista nem o formulário (evita a "piscada" a cada checagem periódica). */
async function syncReminderDataQuietly() {
    try {
        const data = await fetchRemindersOnce();
        currentReminderTimezone = data.timezone || DEFAULT_REMINDER_TIME_ZONE;
        currentReminders = data.reminders;
        notificationScheduler?.setReminders(data.reminders);
        return data.reminders;
    } catch (error) {
        console.error("Falha ao atualizar lembretes em segundo plano:", error);
        return false;
    }
}

async function refreshReminderNotifications() {
    if (permissionKind() !== "granted") {
        stopReminderScheduler();
        renderNotificationCard();
        return;
    }
    const reminders = await syncReminderDataQuietly();
    if (!Array.isArray(reminders)) {
        updateNextReminderLine();
        return;
    }
    if (!notificationScheduler) initializeReminderScheduler(reminders);
    else if (document.visibilityState === "visible") notificationScheduler.handleVisibilityChange(true);
    updateNextReminderLine();
}

notificationButton.addEventListener("click", () => {
    if (notificationButton.disabled) return;
    const kind = permissionKind();
    if (kind === "default") requestNotificationPermissionAndLoad();
    else if (kind === "granted" && reminderLoadState === "error") loadReminderDataForScheduler();
});

notificationTestButton.addEventListener("click", () => {
    try {
        const notification = new window.Notification("MediBot", {
            body: "Notificação de teste: se você está vendo isso, os avisos de lembrete vão funcionar neste navegador."
        });
        notification.onclick = () => { setView("reminders"); notification.close?.(); };
    } catch (error) {
        console.error("Falha ao enviar notificação de teste:", error);
        showToast("Não foi possível enviar a notificação de teste neste navegador.", "error");
    }
});

renderNotificationCard();

// A permissão pode mudar fora do app (ícone de site nas configurações do navegador)
// enquanto a aba está aberta: ao voltar o foco, relemos Notification.permission.
function recheckPermissionOnFocus() {
    if (document.visibilityState !== "visible") {
        notificationScheduler?.handleVisibilityChange(false);
        return;
    }
    if (!Number.isSafeInteger(currentAuthUserId)) return;
    const kind = permissionKind();
    if (kind !== "granted") {
        stopReminderScheduler();
        reminderLoadState = "idle";
        renderNotificationCard();
        return;
    }
    if (reminderLoadState !== "loaded" && reminderLoadState !== "loading") {
        loadReminderDataForScheduler();
        return;
    }
    syncReminderDataQuietly().then((reminders) => {
        if (!Array.isArray(reminders)) return;
        if (!notificationScheduler) initializeReminderScheduler(reminders);
        notificationScheduler?.handleVisibilityChange(true);
        updateNextReminderLine();
    });
}

document.addEventListener("visibilitychange", recheckPermissionOnFocus);
window.addEventListener("focus", recheckPermissionOnFocus);

async function setReminderActive(reminder, active) {
    setReminderFeedback("");
    try {
        const response = await authenticatedFetch(`/api/reminders/${reminder.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active })
        });
        if (!response.ok) throw new Error(await reminderError(response, "Não foi possível atualizar o lembrete."));
        showToast(`Lembrete ${active ? "ativado" : "pausado"} com sucesso.`, "success");
        await loadReminders();
    } catch (error) {
        setReminderFeedback(error instanceof Error ? error.message : "Não foi possível atualizar o lembrete.", "error");
    }
}

async function deleteReminder(id, medicationName) {
    const confirmed = await confirmDialog(`Excluir o lembrete de "${medicationName}"?`, { title: "Excluir lembrete" });
    if (!confirmed) return;
    setReminderFeedback("");
    try {
        const response = await authenticatedFetch(`/api/reminders/${id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(await reminderError(response, "Não foi possível excluir o lembrete."));
        showToast("Lembrete excluído com sucesso.", "success");
        if (editingReminderId === id) resetReminderWizard();
        await loadReminders();
    } catch (error) {
        setReminderFeedback(error instanceof Error ? error.message : "Não foi possível excluir o lembrete.", "error");
    }
}

// ===== Assistente de criação/edição de lembretes (mesmo formulário para os dois) =====

function todayLocalDateInput() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function defaultFirstTime() {
    const now = new Date();
    const roundedMinutes = Math.round(now.getMinutes() / 5) * 5;
    const hour = (now.getHours() + (roundedMinutes >= 60 ? 1 : 0)) % 24;
    return `${String(hour).padStart(2, "0")}:${String(roundedMinutes % 60).padStart(2, "0")}`;
}

function setWizardChipGroupPressed(group, predicate) {
    group.querySelectorAll(".wizard-chip").forEach((chip) => {
        chip.setAttribute("aria-pressed", String(predicate(chip)));
    });
}

function updateWizardIntervalHint() {
    wizardIntervalHint.hidden = wizardIntervalHours === null;
    if (wizardIntervalHours !== null) {
        wizardIntervalHint.textContent = `Os outros horários acompanham o intervalo de ${wizardIntervalHours} em `
            + `${wizardIntervalHours} horas. Para horários livres, escolha "Escolher os horários".`;
    }
}

function renderWizardTimeList() {
    wizardTimeList.replaceChildren();
    wizardTimes.forEach((time, index) => {
        const row = document.createElement("div");
        row.className = "wizard-time-row";
        const input = document.createElement("input");
        input.type = "time";
        input.value = time;
        input.required = true;
        input.addEventListener("input", () => {
            if (wizardIntervalHours !== null && REMINDER_TIME_PATTERN.test(input.value)) {
                // Modo "de X em X horas": recalcula os demais mantendo o intervalo, sem
                // reconstruir a lista (preserva o foco no campo que está sendo editado).
                wizardTimes = recalculateIntervalTimes(wizardTimes, index, input.value, wizardIntervalHours);
                wizardTimeList.querySelectorAll("input[type='time']").forEach((otherInput, otherIndex) => {
                    if (otherIndex !== index) otherInput.value = wizardTimes[otherIndex];
                });
            } else {
                wizardTimes[index] = input.value;
            }
            updateWizardSummary();
        });
        row.append(input);
        if (wizardTimes.length > 1) {
            const removeButton = document.createElement("button");
            removeButton.type = "button";
            removeButton.className = "icon-button";
            removeButton.setAttribute("aria-label", "Remover este horário");
            removeButton.textContent = "✕";
            removeButton.addEventListener("click", () => {
                wizardTimes.splice(index, 1);
                wizardIntervalHours = null;
                setWizardChipGroupPressed(wizardFrequencyOptions, (candidate) => candidate === wizardChooseTimesButton);
                renderWizardTimeList();
                updateWizardSummary();
            });
            row.append(removeButton);
        }
        wizardTimeList.append(row);
    });
    updateWizardIntervalHint();
}

function updateWizardSummary() {
    const medicationOption = wizardMedicationInput.selectedOptions[0];
    const medicationName = medicationOption?.value ? medicationOption.textContent : "Selecione um medicamento";
    const validTimes = wizardTimes.filter((time) => REMINDER_TIME_PATTERN.test(time));
    const weekdays = wizardDayMode === "custom" ? wizardWeekdays : [];
    const endsOn = wizardDurationMode === "days"
        ? computeEndsOn(wizardStartsOnInput.value || todayLocalDateInput(), Number(wizardDurationDaysInput.value))
        : null;
    wizardSummary.textContent = summarizeReminder({ medicationName, times: validTimes, weekdays, endsOn, status: "active" });
}

function resetReminderWizard() {
    editingReminderId = null;
    wizardTimes = [];
    wizardIntervalHours = null;
    wizardDayMode = "all";
    wizardWeekdays = [];
    wizardDurationMode = "forever";
    reminderWizardForm.reset();
    wizardMedicationInput.value = "";
    populateReminderMedicationOptions();
    renderWizardTimeList();
    setWizardChipGroupPressed(wizardFrequencyOptions, () => false);
    setWizardChipGroupPressed(wizardDayModeOptions, (chip) => chip.dataset.dayMode === "all");
    wizardWeekdayList.hidden = true;
    wizardWeekdayList.querySelectorAll(".wizard-weekday").forEach((chip) => chip.setAttribute("aria-pressed", "false"));
    setWizardChipGroupPressed(wizardDurationModeOptions, (chip) => chip.dataset.durationMode === "forever");
    wizardDurationFields.hidden = true;
    wizardStartsOnInput.value = todayLocalDateInput();
    wizardDurationDaysInput.value = "";
    reminderWizardTitle.textContent = "Novo lembrete";
    wizardSaveButton.textContent = "Salvar lembrete";
    wizardCancelButton.hidden = true;
    setReminderFeedback("");
    updateWizardSummary();
}

function fillWizardForEdit(reminder) {
    editingReminderId = reminder.id;
    wizardTimes = reminder.times.length ? [...reminder.times] : [""];
    wizardIntervalHours = null;
    wizardDayMode = reminder.weekdays.length ? "custom" : "all";
    wizardWeekdays = [...reminder.weekdays];
    wizardDurationMode = reminder.endsOn ? "days" : "forever";

    wizardMedicationInput.value = String(reminder.medicationId);
    renderWizardTimeList();
    setWizardChipGroupPressed(wizardFrequencyOptions, (chip) => chip === wizardChooseTimesButton);
    setWizardChipGroupPressed(wizardDayModeOptions, (chip) => chip.dataset.dayMode === wizardDayMode);
    wizardWeekdayList.hidden = wizardDayMode !== "custom";
    wizardWeekdayList.querySelectorAll(".wizard-weekday").forEach((chip) => {
        chip.setAttribute("aria-pressed", String(wizardWeekdays.includes(Number(chip.dataset.weekday))));
    });
    setWizardChipGroupPressed(wizardDurationModeOptions, (chip) => chip.dataset.durationMode === wizardDurationMode);
    wizardDurationFields.hidden = wizardDurationMode !== "days";
    wizardStartsOnInput.value = reminder.startsOn;
    wizardDurationDaysInput.value = reminder.endsOn
        ? String(countDaysInclusive(reminder.startsOn, reminder.endsOn) || "")
        : "";

    reminderWizardTitle.textContent = "Editar lembrete";
    wizardSaveButton.textContent = "Salvar alterações";
    wizardCancelButton.hidden = false;
    setReminderFeedback("");
    updateWizardSummary();
    reminderWizardForm.scrollIntoView({ behavior: "smooth", block: "start" });
    wizardMedicationInput.focus();
}

wizardCancelButton.addEventListener("click", () => resetReminderWizard());
wizardMedicationInput.addEventListener("change", updateWizardSummary);

wizardFrequencyOptions.querySelectorAll(".wizard-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
        const firstTime = wizardTimes.find((time) => REMINDER_TIME_PATTERN.test(time)) || defaultFirstTime();
        if (chip.dataset.count) {
            wizardIntervalHours = null;
            wizardTimes = generateEvenlySpacedTimes(firstTime, Number(chip.dataset.count));
        } else if (chip.dataset.interval) {
            wizardIntervalHours = Number(chip.dataset.interval);
            wizardTimes = generateIntervalTimes(firstTime, wizardIntervalHours);
        } else {
            // "Escolher os horários": mantém o que já existe (ou abre um horário em branco).
            wizardIntervalHours = null;
            if (!wizardTimes.length) wizardTimes = [""];
        }
        renderWizardTimeList();
        setWizardChipGroupPressed(wizardFrequencyOptions, (candidate) => candidate === chip);
        updateWizardSummary();
    });
});

wizardAddTimeButton.addEventListener("click", () => {
    if (wizardTimes.length >= MAX_TIMES_PER_REMINDER) {
        setReminderFeedback(`Você pode adicionar no máximo ${MAX_TIMES_PER_REMINDER} horários por lembrete.`, "error");
        return;
    }
    wizardIntervalHours = null;
    setWizardChipGroupPressed(wizardFrequencyOptions, (candidate) => candidate === wizardChooseTimesButton);
    wizardTimes.push("");
    renderWizardTimeList();
    updateWizardSummary();
});

wizardDayModeOptions.querySelectorAll(".wizard-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
        wizardDayMode = chip.dataset.dayMode;
        wizardWeekdayList.hidden = wizardDayMode !== "custom";
        setWizardChipGroupPressed(wizardDayModeOptions, (candidate) => candidate === chip);
        updateWizardSummary();
    });
});

wizardWeekdayList.querySelectorAll(".wizard-weekday").forEach((chip) => {
    chip.addEventListener("click", () => {
        const weekday = Number(chip.dataset.weekday);
        const pressed = chip.getAttribute("aria-pressed") === "true";
        chip.setAttribute("aria-pressed", String(!pressed));
        wizardWeekdays = pressed
            ? wizardWeekdays.filter((day) => day !== weekday)
            : [...wizardWeekdays, weekday];
        updateWizardSummary();
    });
});

wizardDurationModeOptions.querySelectorAll(".wizard-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
        wizardDurationMode = chip.dataset.durationMode;
        wizardDurationFields.hidden = wizardDurationMode !== "days";
        if (wizardDurationMode === "days" && !wizardStartsOnInput.value) {
            wizardStartsOnInput.value = todayLocalDateInput();
        }
        setWizardChipGroupPressed(wizardDurationModeOptions, (candidate) => candidate === chip);
        updateWizardSummary();
    });
});

wizardDurationDaysInput.addEventListener("input", updateWizardSummary);
wizardStartsOnInput.addEventListener("input", updateWizardSummary);

reminderWizardForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const medicationId = wizardMedicationInput.value;
    const times = wizardTimes.filter((time) => REMINDER_TIME_PATTERN.test(time));
    const uniqueTimes = new Set(times);
    const weekdays = wizardDayMode === "custom" ? wizardWeekdays : [];

    wizardMedicationInput.classList.toggle("input-error", !medicationId);
    if (!medicationId) {
        setReminderFeedback("Selecione o medicamento deste lembrete.", "error");
        return;
    }
    if (!times.length || times.length !== wizardTimes.length) {
        setReminderFeedback("Preencha todos os horários (ou remova os que ficaram em branco).", "error");
        return;
    }
    if (uniqueTimes.size !== times.length) {
        setReminderFeedback("Os horários não podem se repetir.", "error");
        return;
    }

    const payload = { medicationId: Number(medicationId), times, weekdays, active: true };
    if (wizardDurationMode === "days") {
        const startsOn = wizardStartsOnInput.value || todayLocalDateInput();
        const totalDays = Number(wizardDurationDaysInput.value);
        const endsOn = computeEndsOn(startsOn, totalDays);
        if (!endsOn) {
            setReminderFeedback("Informe por quantos dias o lembrete deve continuar (1 ou mais).", "error");
            return;
        }
        payload.startsOn = startsOn;
        payload.endsOn = endsOn;
    } else {
        payload.endsOn = null;
    }
    if (editingReminderId !== null) {
        delete payload.active;
    }

    setReminderLoading(true);
    setReminderFeedback("");
    try {
        const url = editingReminderId === null ? "/api/reminders" : `/api/reminders/${editingReminderId}`;
        const response = await authenticatedFetch(url, {
            method: editingReminderId === null ? "POST" : "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error(await reminderError(response, editingReminderId === null
                ? "Não foi possível adicionar o lembrete."
                : "Não foi possível atualizar o lembrete."));
        }
        const data = await response.json();
        const wasEditing = editingReminderId !== null;
        resetReminderWizard();
        showToast(wasEditing ? "Lembrete atualizado com sucesso." : "Lembrete adicionado com sucesso.", "success");
        if (!wasEditing) track("reminder_created");
        await loadReminders();
        if (data?.reminder?.id !== undefined) highlightReminderCard(data.reminder.id);
    } catch (error) {
        setReminderFeedback(error instanceof Error ? error.message : "Não foi possível salvar o lembrete.", "error");
    } finally {
        setReminderLoading(false);
    }
});

resetReminderWizard();

const telegramStatus = document.querySelector("#telegram-status");
const telegramCodeBox = document.querySelector("#telegram-code-box");
const telegramCodeValue = document.querySelector("#telegram-code-value");
const telegramCopyButton = document.querySelector("#telegram-copy-button");
const telegramRegenerateButton = document.querySelector("#telegram-regenerate-button");
const telegramCountdownEl = document.querySelector("#telegram-countdown");
const telegramCodeRow = document.querySelector("#telegram-code-row");
const telegramCodeHint = document.querySelector("#telegram-code-hint");
const telegramRefreshButton = document.querySelector("#telegram-refresh-button");
const telegramOpenLink = document.querySelector("#telegram-open-link");
const telegramConnectButton = document.querySelector("#telegram-connect-button");
const telegramDisconnectButton = document.querySelector("#telegram-disconnect-button");
const TELEGRAM_CONNECT_DEFAULT_LABEL = "Conectar Telegram";

// Nunca fica em atributo algum do DOM (href, data-*): assim nada que leia o HTML da
// página, como a Medição Aprimorada de cliques de saída do Analytics, chega a ver o
// link com o código de vínculo.
let currentTelegramLink = null;

// O código de vínculo é um segredo de uso único e vida curta (10 min): guardamos em
// sessionStorage (não localStorage) para que ele nunca sobreviva além da sessão do
// navegador, e nunca o enviamos ao Analytics.
const telegramLinkCodeStorageKey = "medibot_telegram_link_code";

function storeTelegramLinkCode(code, expiresAt, telegramLink) {
    try {
        window.sessionStorage.setItem(telegramLinkCodeStorageKey, JSON.stringify({ code, expiresAt, telegramLink }));
    } catch {
        // sem sessionStorage disponível: o código simplesmente não sobrevive a um F5
    }
}

function clearStoredTelegramLinkCode() {
    try {
        window.sessionStorage.removeItem(telegramLinkCodeStorageKey);
    } catch {
        // ignore storage access errors
    }
}

// O servidor guarda só o hash do código (nunca o código em texto puro), então não há
// como pedir pra ele "qual era o código?" de novo: sem o sessionStorage, perder a
// página antes de concluir o vínculo exige gerar um código novo.
function readStoredTelegramLinkCode() {
    try {
        return parseStoredLinkCode(window.sessionStorage.getItem(telegramLinkCodeStorageKey));
    } catch {
        return null;
    }
}

// Escreve no status, anunciando por leitor de tela só quando pedido. O elemento é uma
// região live tanto pelo role="status" quanto pelo aria-live="polite" (o role sozinho
// já implica aria-live polite); por isso removemos os dois antes de uma escrita muda
// e devolvemos logo em seguida, para a mudança ficar visível no DOM sem ser lida.
function setTelegramStatusText(text, { announce = true } = {}) {
    if (!announce) {
        telegramStatus.removeAttribute("role");
        telegramStatus.removeAttribute("aria-live");
    }
    telegramStatus.textContent = text;
    if (!announce) {
        window.requestAnimationFrame(() => {
            telegramStatus.setAttribute("role", "status");
            telegramStatus.setAttribute("aria-live", "polite");
        });
    }
}

function handleTelegramCodeExpired() {
    clearStoredTelegramLinkCode();
    // A linha "Código: ..." some por completo: a mensagem de status abaixo já diz
    // "Código expirado", então mantê-la visível só duplicaria a informação.
    telegramCodeRow.hidden = true;
    telegramCodeValue.textContent = "";
    telegramCountdownEl.textContent = "";
    delete telegramCountdownEl.dataset.level;
    // A dica "código expira em 10 minutos" só faz sentido com um código ativo; some
    // junto com a linha do código.
    telegramCodeHint.hidden = true;
    telegramCopyButton.hidden = true;
    telegramRegenerateButton.hidden = true;
    telegramOpenLink.hidden = true;
    currentTelegramLink = null;
    telegramConnectButton.hidden = false;
    telegramConnectButton.textContent = "Gerar novo código";
    telegramStatus.dataset.state = "expired";
    // Só anuncia por aria-live se a aba Lembretes estiver visível agora; se a pessoa
    // estiver em outra seção, o estado é atualizado em silêncio e ela vê ao voltar.
    setTelegramStatusText(
        "Código expirado. Gere um novo código para concluir o vínculo.",
        { announce: activeView === "reminders" }
    );
}

// O cronômetro roda em qualquer seção do app, não só em Lembretes: o tempo restante
// é sempre recalculado a partir de expiresAt (nunca de um contador decrescente), e a
// classe garante no máximo um setInterval ativo por vez (ver telegramLinkCountdown.js).
const telegramCountdown = new TelegramLinkCountdownTimer({
    onTick: (remainingMs) => {
        // Sem aria-live aqui de propósito: o tempo restante não pode ser anunciado a cada segundo.
        telegramCountdownEl.textContent = `Expira em ${formatCountdown(remainingMs)}`;
        telegramCountdownEl.dataset.level = getCountdownLevel(remainingMs);
    },
    onExpired: handleTelegramCodeExpired
});

function renderTelegramCode({ code, expiresAt, telegramLink }) {
    telegramCodeRow.hidden = false;
    telegramCodeHint.hidden = false;
    telegramStatus.dataset.state = "";
    telegramCodeValue.textContent = code;
    telegramCodeBox.hidden = false;
    telegramCopyButton.hidden = false;
    telegramRegenerateButton.hidden = false;
    telegramConnectButton.hidden = true;
    telegramConnectButton.textContent = TELEGRAM_CONNECT_DEFAULT_LABEL;
    telegramOpenLink.hidden = !telegramLink;
    currentTelegramLink = telegramLink || null;
    telegramCountdown.start(expiresAt);
}

function restoreTelegramCodeFromStorage() {
    const stored = readStoredTelegramLinkCode();
    if (!stored) return;
    if (isCountdownExpired(getRemainingMs(stored.expiresAt, Date.now()))) {
        clearStoredTelegramLinkCode();
        return;
    }
    renderTelegramCode(stored);
}

function renderTelegramLinked(linked) {
    telegramStatus.dataset.state = linked ? "linked" : "";
    telegramStatus.textContent = linked
        ? "Telegram conectado. Você já pode enviar perguntas sobre bulas pelo bot."
        : "Vincule sua conta para consultar bulas também pelo Telegram.";
    telegramConnectButton.hidden = linked;
    telegramConnectButton.textContent = TELEGRAM_CONNECT_DEFAULT_LABEL;
    telegramDisconnectButton.hidden = !linked;
    if (linked) {
        telegramCodeBox.hidden = true;
        telegramOpenLink.hidden = true;
        currentTelegramLink = null;
        telegramCountdown.stop();
        clearStoredTelegramLinkCode();
    }
}

async function generateTelegramLinkCode(isRegeneration = false) {
    telegramConnectButton.disabled = true;
    telegramRegenerateButton.disabled = true;
    try {
        const response = await authenticatedFetch("/api/telegram/link-code", { method: "POST" });
        if (!response.ok) throw new Error(await readError(response, "Não foi possível gerar o código de vínculo."));
        const data = await response.json();
        if (!data || typeof data.code !== "string" || typeof data.telegramLink !== "string" || typeof data.expiresAt !== "string") {
            throw new Error("Resposta inesperada ao gerar o código de vínculo.");
        }
        renderTelegramCode(data);
        storeTelegramLinkCode(data.code, data.expiresAt, data.telegramLink);
        telegramStatus.textContent = isRegeneration
            ? "Novo código gerado. O anterior deixou de valer."
            : "Envie esse código para o bot no Telegram (ou clique no botão 'Abrir no Telegram') para concluir o vínculo.";
        track("telegram_link_generated");
    } catch (error) {
        telegramStatus.textContent = error instanceof Error ? error.message : "Não foi possível gerar o código de vínculo.";
    } finally {
        telegramConnectButton.disabled = false;
        telegramRegenerateButton.disabled = false;
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
        telegramCountdown.stop();
        clearStoredTelegramLinkCode();
        track("telegram_unlinked");
    } catch (error) {
        telegramStatus.textContent = error instanceof Error ? error.message : "Não foi possível desvincular o Telegram.";
    } finally {
        telegramDisconnectButton.disabled = false;
    }
}

telegramOpenLink.addEventListener("click", () => {
    if (currentTelegramLink) window.open(currentTelegramLink, "_blank", "noopener,noreferrer");
});
telegramConnectButton.addEventListener("click", () => generateTelegramLinkCode(false));
telegramRegenerateButton.addEventListener("click", () => generateTelegramLinkCode(true));
telegramCopyButton.addEventListener("click", copyTelegramCode);
telegramRefreshButton.addEventListener("click", refreshTelegramLinkStatus);
telegramDisconnectButton.addEventListener("click", disconnectTelegram);

function formatHistoryDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? "Data não disponível"
        : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function channelBadge(channel) {
    const badge = document.createElement("span");
    const isTelegram = channel === "telegram";
    badge.className = `channel-badge channel-badge-${isTelegram ? "telegram" : "site"}`;
    badge.textContent = isTelegram ? "Telegram" : "Site";
    return badge;
}

function showHistoryEmptyDetail(message = "Selecione uma consulta para ver os detalhes.") {
    historyDetail.replaceChildren();
    delete historyDetail.dataset.queryId;
    const state = document.createElement("p");
    state.className = "history-state";
    state.textContent = message;
    historyDetail.append(state);
}

function showHistoryDetail(query) {
    historyDetail.replaceChildren();
    historyDetail.dataset.queryId = String(query.id);

    const meta = document.createElement("div");
    meta.className = "history-detail-meta";
    const date = document.createElement("span");
    date.className = "history-date";
    date.textContent = formatHistoryDate(query.createdAt || query.created_at);
    meta.append(channelBadge(query.channel), date);

    const title = document.createElement("h3");
    title.textContent = "Sua pergunta";
    const question = document.createElement("p");
    question.textContent = query.question;
    const answerTitle = document.createElement("h3");
    answerTitle.textContent = "Resposta do MediBot";
    const answer = document.createElement("div");
    answer.className = "markdown-content";
    renderMarkdown(answer, query.answer);
    historyDetail.append(meta, title, question, answerTitle, answer);

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
        showHistoryEmptyDetail(error instanceof Error ? error.message : "Não foi possível carregar esta consulta.");
    }
}

async function deleteHistoryQuery(id) {
    if (historyFeedback) historyFeedback.textContent = "";
    try {
        const response = await authenticatedFetch(`/api/queries/${id}`, { method: "DELETE" });
        if (!response.ok && response.status !== 404) {
            throw new Error(await readError(response, "Não foi possível apagar esta consulta."));
        }
        track("history_item_deleted");
        if (historyDetail.dataset.queryId === String(id)) {
            showHistoryEmptyDetail();
        }
        await loadQueryHistory();
    } catch (error) {
        if (historyFeedback) {
            historyFeedback.textContent = error instanceof Error ? error.message : "Não foi possível apagar esta consulta.";
        }
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
            const item = document.createElement("div");
            item.className = "history-item";

            const mainButton = document.createElement("button");
            mainButton.type = "button";
            mainButton.className = "history-item-main";
            mainButton.title = query.question;
            const question = document.createElement("span");
            question.className = "history-question";
            question.textContent = query.question;
            const meta = document.createElement("span");
            meta.className = "history-item-meta";
            const date = document.createElement("span");
            date.className = "history-date";
            date.textContent = formatHistoryDate(query.createdAt || query.created_at);
            meta.append(channelBadge(query.channel), date);
            mainButton.append(question, meta);
            mainButton.addEventListener("click", () => {
                historyList.querySelectorAll(".history-item").forEach((element) => element.classList.remove("active"));
                item.classList.add("active");
                loadQueryDetail(query.id);
            });

            const deleteButton = document.createElement("button");
            deleteButton.type = "button";
            deleteButton.className = "history-item-delete";
            deleteButton.setAttribute("aria-label", "Apagar esta consulta");
            deleteButton.title = "Apagar esta consulta";
            deleteButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

            const confirm = document.createElement("div");
            confirm.className = "history-item-confirm";
            confirm.hidden = true;
            const confirmLabel = document.createElement("span");
            confirmLabel.textContent = "Apagar esta consulta?";
            const confirmYes = medicationButton("Apagar", "danger-button", async () => {
                confirmYes.disabled = true;
                confirmNo.disabled = true;
                await deleteHistoryQuery(query.id);
            });
            const confirmNo = medicationButton("Cancelar", "secondary-button", () => {
                confirm.hidden = true;
                deleteButton.hidden = false;
            });
            confirm.append(confirmLabel, confirmYes, confirmNo);

            deleteButton.addEventListener("click", (event) => {
                event.stopPropagation();
                deleteButton.hidden = true;
                confirm.hidden = false;
            });

            item.append(mainButton, deleteButton, confirm);
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
    activeView = view;
    trackPageView(view);
}

// Navegadores reduzem a frequência de timers em abas em segundo plano: ao voltar a
// ficar visível (troca de aba do navegador ou restauração via bfcache), recalcula o
// cronômetro do Telegram na hora por expiresAt, sem esperar o próximo segundo.
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") telegramCountdown.tick();
});
window.addEventListener("pageshow", () => telegramCountdown.tick());

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    setView(button.dataset.view);
    if (button.dataset.view === "history") {
        loadQueryHistory();
        track("history_open");
    }
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
document.querySelector("#show-forgot-password").addEventListener("click", showForgotPassword);
document.querySelector("#show-login-from-forgot").addEventListener("click", () => showLogin());

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
        track("login", { method: identifier.includes("@") ? "email" : "phone" });
        showApplication(data.user);
    } catch (error) {
        loginFeedback.textContent = error instanceof Error ? error.message : "Não foi possível entrar.";
    }
});

registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.querySelector("#register-name").value.trim();
    const email = document.querySelector("#register-email").value.trim();
    const emailConfirm = document.querySelector("#register-email-confirm").value.trim();
    const phone = document.querySelector("#register-phone").value.trim();
    const password = document.querySelector("#register-password").value;
    registerFeedback.textContent = "";

    if (!email) {
        registerFeedback.textContent = "Informe um e-mail.";
        return;
    }
    if (email.toLowerCase() !== emailConfirm.toLowerCase()) {
        registerFeedback.textContent = "Os e-mails informados não coincidem.";
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
        track("sign_up", { method: "email" });
        showLogin("Conta criada com sucesso. Agora entre com seu e-mail ou telefone e senha.", true);
    } catch (error) {
        registerFeedback.textContent = error instanceof Error ? error.message : "Não foi possível criar a conta.";
    }
});

forgotPasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.querySelector("#forgot-password-email").value.trim();
    const submitButton = document.querySelector("#forgot-password-submit");
    forgotPasswordFeedback.textContent = "";
    forgotPasswordFeedback.classList.remove("success");
    submitButton.disabled = true;
    try {
        const response = await fetch("/api/auth/forgot-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email })
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 400) throw new Error(data?.error || "Informe um e-mail válido.");
        forgotPasswordForm.reset();
        forgotPasswordFeedback.textContent = data?.message || "Se esse e-mail estiver cadastrado, enviamos um link para redefinir a senha.";
        forgotPasswordFeedback.classList.add("success");
        track("password_reset_requested");
    } catch (error) {
        forgotPasswordFeedback.textContent = error instanceof Error ? error.message : "Não foi possível processar o pedido.";
    } finally {
        submitButton.disabled = false;
    }
});

resetPasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = document.querySelector("#reset-password-password").value;
    const passwordConfirm = document.querySelector("#reset-password-password-confirm").value;
    const submitButton = document.querySelector("#reset-password-submit");
    resetPasswordFeedback.textContent = "";
    resetPasswordFeedback.classList.remove("success");

    if (password !== passwordConfirm) {
        resetPasswordFeedback.textContent = "As senhas informadas não coincidem.";
        return;
    }
    if (!pendingPasswordResetToken) {
        resetPasswordFeedback.textContent = "Link inválido ou expirado.";
        resetPasswordRequestNew.hidden = false;
        return;
    }

    submitButton.disabled = true;
    try {
        const response = await fetch("/api/auth/reset-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: pendingPasswordResetToken, password })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            resetPasswordFeedback.textContent = data?.error || "Não foi possível redefinir a senha.";
            if (response.status === 400) resetPasswordRequestNew.hidden = false;
            return;
        }
        pendingPasswordResetToken = null;
        resetPasswordForm.reset();
        track("password_reset_completed");
        showLogin(data?.message || "Senha redefinida com sucesso. Faça login com sua nova senha.", true);
    } catch {
        resetPasswordFeedback.textContent = "Não foi possível redefinir a senha. Verifique sua conexão e tente novamente.";
    } finally {
        submitButton.disabled = false;
    }
});

document.querySelector("#reset-password-request-new-button").addEventListener("click", () => {
    pendingPasswordResetToken = null;
    showForgotPassword();
});

document.querySelector("#logout-button").addEventListener("click", () => showAuthentication());

async function fetchPasswordResetCapability() {
    try {
        const response = await fetch("/api/auth/capabilities");
        if (!response.ok) return false;
        const data = await response.json();
        return data?.passwordReset === true;
    } catch {
        return false;
    }
}

async function initializeApplication() {
    const passwordResetEnabled = await fetchPasswordResetCapability();
    document.querySelector("#show-forgot-password-wrapper").hidden = !passwordResetEnabled;

    if (pendingPasswordResetToken) {
        if (passwordResetEnabled) {
            showResetPassword();
            return;
        }
        pendingPasswordResetToken = null;
    }

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
