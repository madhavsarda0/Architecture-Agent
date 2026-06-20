require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ─── CORS: allow any origin to call this API. Claude artifacts can render
// from origins that aren't predictable in advance, so we keep this open
// rather than guess. Since the real protection here is that nobody can see
// the API keys themselves (they never leave this server), an open CORS
// policy is an acceptable tradeoff for a personal/shared tool like this.
app.use(cors());

// ════════════════════════════════════════════════════════════════════════
// MODEL CONFIG — mirrors the frontend's MODELS object. apiModel + provider
// only; the real secret keys live in process.env and never leave this file.
// ════════════════════════════════════════════════════════════════════════
const MODELS = {
  or_claude_haiku: { provider: "openrouter", apiModel: "anthropic/claude-3.5-haiku" },
  gemini_flash: { provider: "google", apiModel: "gemini-2.5-flash" },
  gemini_pro: { provider: "google", apiModel: "gemini-2.5-pro-preview-06-05" },
  groq_llama: { provider: "groq", apiModel: "llama-3.3-70b-versatile" },
  groq_mixtral: { provider: "groq", apiModel: "mixtral-8x7b-32768" },
  mistral_codestral: { provider: "mistral", apiModel: "codestral-latest" },
  deepseek_r1: { provider: "openrouter", apiModel: "deepseek/deepseek-r1:free" },
  qwen3: { provider: "openrouter", apiModel: "qwen/qwen3-235b-a22b:free" },
  deepseek_v3: { provider: "openrouter", apiModel: "deepseek/deepseek-chat:free" },
  perplexity_sonar: { provider: "perplexity", apiModel: "sonar" },
};

const PROVIDER_KEYS = {
  google: process.env.GOOGLE_API_KEY,
  groq: process.env.GROQ_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
  mistral: process.env.MISTRAL_API_KEY,
  perplexity: process.env.PERPLEXITY_API_KEY,
};

async function callChatStyle(endpoint, model, prompt, key, extraHeaders) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(extraHeaders || {}) },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 4000, temperature: 0.7 }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Request failed (${response.status})`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "No response received.";
}

async function callGoogleModel(model, prompt, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 4000, temperature: 0.7 } }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Request failed (${response.status})`);
  }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response received.";
}

async function callModel(modelKey, prompt) {
  const m = MODELS[modelKey];
  if (!m) throw new Error("Unknown model.");
  const key = PROVIDER_KEYS[m.provider];
  if (!key) throw new Error(`Server is missing an API key for ${m.provider}. Set it in the server's .env file.`);

  if (m.provider === "google") return callGoogleModel(m.apiModel, prompt, key);
  if (m.provider === "openrouter")
    return callChatStyle("https://openrouter.ai/api/v1/chat/completions", m.apiModel, prompt, key, {
      "HTTP-Referer": "https://warpsync.in",
      "X-Title": "Architecture Agent",
    });
  if (m.provider === "groq") return callChatStyle("https://api.groq.com/openai/v1/chat/completions", m.apiModel, prompt, key);
  if (m.provider === "mistral") return callChatStyle("https://api.mistral.ai/v1/chat/completions", m.apiModel, prompt, key);
  if (m.provider === "perplexity") return callChatStyle("https://api.perplexity.ai/chat/completions", m.apiModel, prompt, key);
  throw new Error("Unknown provider.");
}

// ════════════════════════════════════════════════════════════════════════
// SEARCH LOGGING — simple append-only JSON file. Good enough for low/medium
// traffic. Swap for a real database later if this tool gets heavy use.
// ════════════════════════════════════════════════════════════════════════
const LOG_PATH = path.join(__dirname, "search-log.json");

function readLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
  } catch (e) {
    return [];
  }
}

function appendLog(entry) {
  const log = readLog();
  log.push(entry);
  // Keep the log from growing forever — trim to most recent 2000 entries
  const trimmed = log.slice(-2000);
  fs.writeFileSync(LOG_PATH, JSON.stringify(trimmed, null, 2));
}

// ════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════

// Run a single model. Frontend calls this once per model in its top-4 picks.
app.post("/api/run-model", async (req, res) => {
  const { modelKey, prompt, projectDesc, clientId } = req.body || {};
  if (!modelKey || !prompt) return res.status(400).json({ error: "modelKey and prompt are required." });

  try {
    const text = await callModel(modelKey, prompt);
    appendLog({
      time: new Date().toISOString(),
      modelKey,
      projectDesc: (projectDesc || "").slice(0, 300),
      clientId: clientId || null,
      status: "ok",
    });
    res.json({ text });
  } catch (e) {
    appendLog({
      time: new Date().toISOString(),
      modelKey,
      projectDesc: (projectDesc || "").slice(0, 300),
      clientId: clientId || null,
      status: "error",
      error: e.message,
    });
    res.status(502).json({ error: e.message });
  }
});

// Which providers actually have a key configured server-side (so the
// frontend can show accurate "available" badges without ever seeing keys).
app.get("/api/provider-status", (req, res) => {
  const status = {};
  Object.keys(PROVIDER_KEYS).forEach((p) => {
    status[p] = !!PROVIDER_KEYS[p];
  });
  res.json(status);
});

// Admin: view the search log. Requires the passphrase as a header.
app.get("/api/admin/log", (req, res) => {
  const passphrase = req.headers["x-admin-passphrase"];
  if (!passphrase || passphrase !== process.env.ADMIN_PASSPHRASE) {
    return res.status(401).json({ error: "Invalid or missing admin passphrase." });
  }
  const log = readLog();
  res.json({ count: log.length, entries: log.slice().reverse() });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Architecture Agent backend listening on port ${PORT}`));
