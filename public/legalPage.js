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
