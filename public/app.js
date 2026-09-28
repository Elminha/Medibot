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
        const dosage = document.createElement("p");
        dosage.className = "medication-details";
        dosage.textContent = `Dosagem: ${medication.dosage}`;
        card.append(dosage);
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
            const response = await fetch(`/api/medications/${medication.id}`, {
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
        const empty = document.createElement("p");
        empty.className = "medication-state";
        empty.textContent = "Você ainda não cadastrou medicamentos.";
        medicationList.append(empty);
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
        const response = await fetch("/api/medications");
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
        const response = await fetch(`/api/medications/${id}`, { method: "DELETE" });
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
        const response = await fetch("/api/medications", {
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

    const details = document.createElement("p");
    details.className = "reminder-details";
    details.textContent = `Horário: ${reminder.time} · Frequência: ${frequencyLabel(reminder.frequency)}`;

    const actions = document.createElement("div");
    actions.className = "reminder-actions";
    actions.append(
        reminderButton("Editar", "secondary-button", () => showReminderEditor(card, reminder)),
        reminderButton(reminder.active ? "Desativar" : "Ativar", "secondary-button", () => setReminderActive(reminder, !reminder.active)),
        reminderButton("Excluir", "danger-button", () => deleteReminder(reminder.id, reminder.medicationName))
    );
    card.append(header, details, actions);
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
            const response = await fetch(`/api/reminders/${reminder.id}`, {
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
        const empty = document.createElement("p");
        empty.className = "reminder-state";
        empty.textContent = "Você ainda não cadastrou lembretes.";
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
        const response = await fetch("/api/reminders");
        if (!response.ok) throw new Error(await reminderError(response, "Não foi possível carregar os lembretes."));
        const data = await response.json();
        if (!data || !Array.isArray(data.reminders)) throw new Error("Resposta inesperada ao carregar lembretes.");
        renderReminders(data.reminders);
    } catch (error) {
        reminderList.replaceChildren();
        const message = document.createElement("p");
        message.className = "reminder-state feedback-error";
        message.textContent = error instanceof Error ? error.message : "Não foi possível carregar os lembretes.";
        reminderList.append(message);
        setReminderFeedback("Verifique sua conexão e tente novamente.", "error");
    } finally {
        setReminderLoading(false);
    }
}

async function setReminderActive(reminder, active) {
    setReminderFeedback("");
    try {
        const response = await fetch(`/api/reminders/${reminder.id}`, {
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
        const response = await fetch(`/api/reminders/${id}`, { method: "DELETE" });
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
        const response = await fetch("/api/reminders", {
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

Promise.all([loadMedications(), loadReminders()]);
