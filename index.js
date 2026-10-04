/**
 * Expressions Local Injector
 *
 * Lets SillyTavern's Character Expressions extension classify with your own OpenAI-compatible
 * connection (e.g. LM Studio). It answers the requests of the "Local" classifier, so neither
 * SillyTavern nor the Expressions extension have to be changed.
 */

import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";

const MODULE_NAME = "expressions_local_injector";

// Requests of the Expressions extension when its classifier API is "Local"
const CLASSIFY_PATH = "/api/extra/classify";
const LABELS_PATH = "/api/extra/classify/labels";

// Same labels as the built-in Local classifier, so the local model never has to be loaded for the list
const DEFAULT_LABELS = [
    "admiration", "amusement", "anger", "annoyance", "approval", "caring", "confusion",
    "curiosity", "desire", "disappointment", "disapproval", "disgust", "embarrassment",
    "excitement", "fear", "gratitude", "grief", "joy", "love", "nervousness", "optimism",
    "pride", "realization", "relief", "remorse", "sadness", "surprise", "neutral"
];

const DEFAULT_PROMPT = `Classify the emotion expressed in the following text. Reply with exactly one word from this list: {{labels}}

Text: {{text}}

Emotion:`;

const TEST_TEXT = "I can't believe you remembered my birthday, this is wonderful!";

const defaultSettings = {
    enabled: false,
    apiUrl: "http://127.0.0.1:1234/v1/chat/completions",
    model: "",
    apiKey: "",
    maxTokens: 20,
    prompt: DEFAULT_PROMPT
};

// Kept before wrapping, also used for our own requests
const originalFetch = window.fetch;

// Last classified expression per character, kept while a reply is streaming
const labelsBySpeaker = new Map();

/**
 * Name of the character whose message Expressions classifies, i.e. the last character message.
 * @returns {string}
 */
function getSpeaker() {
    const chat = getContext().chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) return chat[i].name ?? "";
    }
    return "";
}

function isStreaming() {
    const { streamingProcessor } = getContext();
    return !!streamingProcessor && !streamingProcessor.isFinished;
}

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

/**
 * The expressions to choose from: the default labels plus the custom expressions of the Expressions extension.
 * @returns {string[]}
 */
function getLabels() {
    const custom = extension_settings.expressions?.custom ?? [];
    return [...new Set([...DEFAULT_LABELS, ...custom])];
}

function buildHeaders(settings) {
    const headers = { "Content-Type": "application/json" };
    if (settings.apiKey) {
        headers["Authorization"] = `Bearer ${settings.apiKey}`;
    }
    return headers;
}

// Chat completion endpoints (e.g. /v1/chat/completions) expect messages instead of a single text prompt
function isChatEndpoint(url) {
    return /\/chat\/completions\/?(\?.*)?$/i.test(String(url ?? "").trim());
}

/**
 * Reads the generated text from a completion or chat completion response.
 * @param {any} data Parsed response
 * @returns {string|undefined} Generated text, undefined for an unknown response format
 */
function readCompletionText(data) {
    const choice = data?.choices?.[0];
    if (choice?.message) return choice.message.content ?? "";
    return choice?.text ?? data?.generated_text;
}

/**
 * Fills in the placeholders in a single pass, so placeholders inside the message stay untouched.
 * @param {string} template Prompt template
 * @param {{labels: string, text: string}} values Placeholder values
 * @returns {string} Filled prompt
 */
function fillPrompt(template, values) {
    return template.replace(/\{\{(labels|text)\}\}/gi, (_, key) => values[key.toLowerCase()]);
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the expression the model chose: the label mentioned first, the longer one on a tie.
 * Reasoning blocks (<think>…</think>) are ignored.
 * @param {string} reply Model reply
 * @param {string[]} labels Available expressions
 * @returns {string|null} The matched label, null if the reply contains none
 */
function matchLabel(reply, labels) {
    const text = String(reply ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").toLowerCase();
    let best = null;
    let bestIndex = Infinity;
    for (const label of labels) {
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(label.toLowerCase())}(?![\\p{L}\\p{N}_])`, "u");
        const match = pattern.exec(text);
        if (!match) continue;
        if (match.index < bestIndex || (match.index === bestIndex && label.length > best.length)) {
            best = label;
            bestIndex = match.index;
        }
    }
    return best;
}

async function requestCompletion(settings, prompt) {
    const body = isChatEndpoint(settings.apiUrl)
        ? { messages: [{ role: "user", content: prompt }] }
        : { prompt };
    body.max_tokens = settings.maxTokens > 0 ? settings.maxTokens : defaultSettings.maxTokens;
    body.temperature = 0.2;
    if (settings.model) {
        body.model = settings.model;
    }

    const response = await originalFetch.call(window, settings.apiUrl, {
        method: "POST",
        headers: buildHeaders(settings),
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const text = readCompletionText(await response.json());
    if (text === undefined) {
        throw new Error("unexpected response format, is this a completions or chat completions endpoint?");
    }
    return text;
}

/**
 * Classifies a text with the configured connection.
 * @param {string} text Text to classify
 * @returns {Promise<{label: string|null, reply: string}>}
 */
async function classify(text) {
    const settings = extension_settings[MODULE_NAME];
    const labels = getLabels();
    const template = settings.prompt?.trim() ? settings.prompt : DEFAULT_PROMPT;
    const reply = await requestCompletion(settings, fillPrompt(template, { labels: labels.join(", "), text }));
    return { label: matchLabel(reply, labels), reply };
}

function showLastClassification(text) {
    $("#eli_last").val(text);
}

/**
 * Answers a classify request of the Expressions extension.
 * @param {string} body Request body
 * @returns {Promise<string|null>} The label, null to let the built-in Local classifier answer instead
 */
async function handleClassifyRequest(body) {
    let text;
    try {
        text = JSON.parse(body)?.text;
    } catch {
        return null;
    }
    if (!text) return null;

    // Expressions asks again every 2 seconds while a reply is streaming, because the text keeps changing.
    // Like its own LLM mode, skip those requests and keep the character's expression; the finished reply is classified afterwards.
    const speaker = getSpeaker();
    if (isStreaming()) {
        return labelsBySpeaker.get(speaker) ?? "neutral";
    }

    try {
        const { label, reply } = await classify(text);
        if (!label) {
            console.warn("Expressions Local Injector: The reply contains no known expression", reply);
            showLastClassification(`No known expression in reply: ${reply.trim().slice(0, 80)}`);
            return null;
        }
        labelsBySpeaker.set(speaker, label);
        showLastClassification(`${label} ← ${text.trim().slice(0, 80)}`);
        return label;
    } catch (error) {
        console.error("Expressions Local Injector: Classification failed", error);
        toastr.error(`Classification failed (${error.message}). Using the built-in Local classifier instead.`, "Expressions Local Injector", { preventDuplicates: true });
        return null;
    }
}

function getPath(input) {
    try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
        return new URL(url, window.location.origin).pathname;
    } catch {
        return "";
    }
}

function jsonResponse(data) {
    return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" }
    });
}

// Answer the requests of the Local classifier, pass everything else through unchanged
window.fetch = async function (input, init) {
    const settings = extension_settings[MODULE_NAME];
    if (settings?.enabled && String(init?.method ?? "GET").toUpperCase() === "POST") {
        const path = getPath(input);
        if (path === LABELS_PATH) {
            return jsonResponse({ labels: DEFAULT_LABELS });
        }
        if (path === CLASSIFY_PATH && typeof init?.body === "string") {
            const label = await handleClassifyRequest(init.body);
            if (label) {
                return jsonResponse({ classification: [{ label, score: 1 }] });
            }
        }
    }
    return originalFetch.call(window, input, init);
};

async function testConnection() {
    const settings = extension_settings[MODULE_NAME];
    const $status = $("#eli_status");
    const report = (ok, text) => {
        $status.removeClass("eli-status-ok eli-status-fail")
            .addClass(ok ? "eli-status-ok" : "eli-status-fail")
            .text(text);
        toastr[ok ? "success" : "error"](text, "Expressions Local Injector");
    };

    if (!settings.apiUrl) {
        report(false, "No API URL set");
        return;
    }

    $status.removeClass("eli-status-ok eli-status-fail").text("Testing connection...");
    try {
        const { label, reply } = await classify(TEST_TEXT);
        if (label) {
            report(true, `Working – test sentence classified as "${label}"`);
        } else {
            report(false, `Connected, but the reply contains no known expression: "${reply.trim().slice(0, 60)}"`);
        }
    } catch (error) {
        console.error("Expressions Local Injector: Connection test failed", error);
        report(false, `Connection failed (${error.message})`);
        return;
    }

    // The connection is only used when Expressions asks the Local classifier
    if (!settings.enabled) {
        toastr.info("The injector is switched off, enable it to use this connection.", "Expressions Local Injector");
    } else if (extension_settings.expressions && extension_settings.expressions.api !== 0) {
        toastr.warning("Character Expressions does not use the Local classifier. Set its Classifier API to Local.", "Expressions Local Injector");
    }
}

const settingsHtml = `
<div id="eli_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Expressions Local Injector</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label" for="eli_enabled">
                <input id="eli_enabled" type="checkbox" />
                <span>Classify expressions with this connection</span>
            </label>
            <small class="eli_hint">Set <b>Character Expressions → Classifier API</b> to <b>Local</b>. Its requests are then answered by the connection below.</small>

            <label for="eli_api_url">API URL (/v1/chat/completions or /v1/completions):</label>
            <input id="eli_api_url" type="text" class="text_pole" placeholder="http://127.0.0.1:1234/v1/chat/completions" />

            <label for="eli_model">Model Name (optional):</label>
            <input id="eli_model" type="text" class="text_pole" placeholder="Leave empty to use the loaded model" />

            <label for="eli_api_key">API Key (only if required by your server):</label>
            <input id="eli_api_key" type="text" class="text_pole" placeholder="Leave empty if not required" />

            <label for="eli_max_tokens">Max Response Length (tokens):</label>
            <input id="eli_max_tokens" type="number" min="1" class="text_pole" />

            <label for="eli_prompt">Classification Prompt:</label>
            <textarea id="eli_prompt" class="text_pole textarea_compact" rows="6"></textarea>
            <small class="eli_hint">Placeholders: <code>{{labels}}</code> the available expressions, <code>{{text}}</code> the message to classify. An empty field uses the default.</small>

            <div class="flex-container alignitemscenter eli_row">
                <input id="eli_prompt_reset" class="menu_button" type="button" value="Restore default prompt" />
                <input id="eli_test" class="menu_button" type="button" value="Test Connection" />
            </div>
            <span id="eli_status">Not tested</span>

            <label for="eli_last">Last Classification (read-only):</label>
            <input id="eli_last" type="text" class="text_pole" readonly placeholder="No classification yet" />
        </div>
    </div>
</div>`;

function bindSettingsUI() {
    const settings = extension_settings[MODULE_NAME];

    $("#eli_enabled").prop("checked", settings.enabled).on("change", function () {
        settings.enabled = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#eli_api_url").val(settings.apiUrl).on("input", function () {
        settings.apiUrl = String($(this).val());
        saveSettingsDebounced();
    });

    $("#eli_model").val(settings.model).on("input", function () {
        settings.model = String($(this).val());
        saveSettingsDebounced();
    });

    $("#eli_api_key").val(settings.apiKey).on("input", function () {
        settings.apiKey = String($(this).val());
        saveSettingsDebounced();
    });

    $("#eli_max_tokens").val(settings.maxTokens).on("input", function () {
        settings.maxTokens = Number($(this).val());
        saveSettingsDebounced();
    });

    $("#eli_prompt").val(settings.prompt).on("input", function () {
        settings.prompt = String($(this).val());
        saveSettingsDebounced();
    });

    $("#eli_prompt_reset").on("click", function () {
        if (!confirm("Restore the default classification prompt? Your changes will be lost.")) return;
        settings.prompt = DEFAULT_PROMPT;
        $("#eli_prompt").val(settings.prompt);
        saveSettingsDebounced();
    });

    $("#eli_test").on("click", testConnection);
}

jQuery(() => {
    loadSettings();
    $("#extensions_settings2").append(settingsHtml);
    bindSettingsUI();
});
