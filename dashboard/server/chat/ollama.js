// Ollama client for the chat route: /api/chat with stream false, and /api/show to learn whether the
// chat model has the thinking capability. Settings are chat plan section 5.
const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";
const CHAT_OPTIONS = Object.freeze({ temperature: 0, seed: 42, num_predict: 200, num_ctx: 2048 });
const SHOW_TIMEOUT_MS = 5000;

class OllamaError extends Error {}

// model, keepAlive: from CHAT_MODEL and CHAT_KEEP_ALIVE. fetchImpl: for tests.
function createOllama({ url = OLLAMA_URL, model, keepAlive = "5m", fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  // Cached only after a successful /api/show, so a model that is pulled later is still checked.
  let thinking = null;

  async function canThink() {
    if (thinking !== null) return thinking;
    try {
      const res = await doFetch(`${url}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const body = await res.json();
      thinking = Array.isArray(body.capabilities) && body.capabilities.includes("thinking");
      return thinking;
    } catch {
      return false;
    }
  }

  // Returns { text, promptTokens, evalTokens, evalMs, loadMs, latencyMs }. Throws OllamaError when
  // Ollama is down, answers with an error or does not answer within timeoutMs.
  async function chat(messages, timeoutMs) {
    const payload = { model, messages, stream: false, keep_alive: keepAlive, options: { ...CHAT_OPTIONS } };
    if (await canThink()) payload.think = false;
    const started = Date.now();
    let res;
    try {
      res = await doFetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
    } catch (err) {
      throw new OllamaError(err && err.name === "TimeoutError" ? "timeout" : "unreachable");
    }
    if (!res.ok) throw new OllamaError(`http ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch (err) {
      throw new OllamaError(err && err.name === "TimeoutError" ? "timeout" : "bad response");
    }
    if (!body || body.error || !body.message || typeof body.message.content !== "string") throw new OllamaError("bad response");
    const ns = (key) => (Number.isFinite(Number(body[key])) ? Number(body[key]) / 1e6 : null);
    return {
      text: body.message.content.trim(),
      promptTokens: Number(body.prompt_eval_count) || 0,
      evalTokens: Number(body.eval_count) || 0,
      evalMs: ns("eval_duration"),
      loadMs: ns("load_duration"),
      latencyMs: Date.now() - started,
    };
  }

  // True when Ollama answers /api/version within 2 s. Read-only, for the stats route.
  async function ping() {
    try {
      const res = await doFetch(`${url}/api/version`, { method: "GET", signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  return { chat, canThink, ping, model };
}

module.exports = { createOllama, OllamaError, CHAT_OPTIONS, OLLAMA_URL };
