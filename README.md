# Expressions Local Injector

Lets SillyTavern's built-in **Character Expressions** extension classify emotions with your own OpenAI-compatible connection, for example a small model in LM Studio, independently of the API you chat with.

The injector answers the requests of the Expressions **Local** classifier. Neither SillyTavern nor the Expressions extension is changed.

## Installation

1. Open the Extensions panel in SillyTavern and click **Install extension**.
2. Enter `https://github.com/X00LA/SillyTavern-Expressions-Local-Injector` and confirm.

## Setup

1. Extensions panel → **Character Expressions** → set **Classifier API** to **Local**.
2. Extensions panel → **Expressions Local Injector**:
   - enter the **API URL** of your server, e.g. `http://127.0.0.1:1234/v1/chat/completions` for LM Studio
   - optionally enter a **Model Name**
   - click **Test Connection**. It classifies a test sentence and shows the result as a notification
   - enable **Classify expressions with this connection**

From then on, every expression is classified by your connection. **Last Classification** shows the most recent result.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Classify expressions with this connection | off | Switches the injector on. When off, the Local classifier works as usual |
| API URL | `http://127.0.0.1:1234/v1/chat/completions` | Chat completions or completions endpoint; the type is detected from the URL |
| Model Name | empty | Sent as `model`; leave empty to use the model loaded on the server |
| API Key | empty | Sent as `Authorization: Bearer …` if set |
| Max Response Length | 20 | Maximum tokens of the reply. Raise it for reasoning models that think before answering |
| Classification Prompt | see below | Prompt sent to the model |
| Restore default prompt | – | Resets the prompt to the default |
| Test Connection | – | Classifies a test sentence and reports the result |
| Last Classification | – | Read-only. The most recent expression and the text it was chosen for |

## Classification prompt

Placeholders:

| Placeholder | Replaced with |
| --- | --- |
| `{{labels}}` | The available expressions: the 28 default expressions plus your custom expressions from Character Expressions |
| `{{text}}` | The message to classify |

Default prompt:

```text
Classify the emotion expressed in the following text. Reply with exactly one word from this list: {{labels}}

Text: {{text}}

Emotion:
```

The reply may be a single word or a sentence: the first expression mentioned in it is used, and reasoning blocks (`<think>…</think>`) are ignored.

## Good to know

- While a reply is streaming, Expressions asks again every 2 seconds, because the text keeps changing. The injector sends no requests during that time and keeps the character's last expression. Once the reply is complete, it is classified with a single request.
- If the connection fails or the reply contains no known expression, the request goes to the built-in Local classifier instead, so Expressions keeps working. A failure shows a notification. The built-in classifier may download its local model the first time this happens.
- While the injector is on, it also provides the list of expressions, so the local model is not loaded for that.
- "Filter available expressions" from Character Expressions does not apply in Local mode. The model chooses from all expressions; if a sprite is missing, SillyTavern shows the fallback expression.
- The browser sends the requests directly to your server. LM Studio may need **CORS** enabled in its server settings.
- The injector works by intercepting two requests of the Expressions extension (`/api/extra/classify` and `/api/extra/classify/labels`). If a future SillyTavern version changes them, the injector needs an update.

## License

MIT, see [LICENSE](LICENSE).
