const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
const RULES_FILE = path.join(__dirname, 'rules.json');
const MAX_HISTORY_MESSAGES = 20; // per JID, total (user + assistant)

app.use(cors());
app.use(express.json());

// ─── Gemini Client ────────────────────────────────────────────────────────────
// Free API key: https://aistudio.google.com — no credit card required
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  systemInstruction:
    'You are a helpful, friendly WhatsApp assistant. Keep your replies concise and conversational. ' +
    'Avoid markdown formatting like ** or ## since WhatsApp renders plain text. ' +
    'Use short paragraphs or line breaks for clarity.',
});

// ─── State ────────────────────────────────────────────────────────────────────
let cachedQR = null;
let qrTimestamp = null;
let connectionStatus = 'disconnected';
let sockInstance = null;
const QR_MAX_AGE_MS = 55000;

// Per-JID conversation history for AI context
const conversationHistory = new Map();

// ─── Rules ────────────────────────────────────────────────────────────────────
function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveRules(rules) {
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}

function matchRule(text, rules) {
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.pattern, rule.flags || 'i');
      if (regex.test(text)) return rule;
    } catch {
      // skip invalid regex rules
    }
  }
  return null;
}

// ─── AI Response (Google Gemini — free tier) ──────────────────────────────────
async function getAIResponse(jid, userMessage) {
  if (!conversationHistory.has(jid)) {
    conversationHistory.set(jid, []);
  }

  const history = conversationHistory.get(jid);

  // Trim to last MAX_HISTORY_MESSAGES before sending
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);

  // Gemini history format: role is 'user' or 'model', parts is array of {text}
  const geminiHistory = trimmed.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }],
  }));

  const chat = geminiModel.startChat({ history: geminiHistory });
  const result = await chat.sendMessage(userMessage);
  const reply = result.response.text();

  // Store in simple format
  history.push({ role: 'user', text: userMessage });
  history.push({ role: 'assistant', text: reply });

  // Keep history bounded
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }

  return reply;
}

// ─── Incoming Message Handler ─────────────────────────────────────────────────
async function handleIncomingMessage(sock, msg) {
  // Ignore self-sent messages
  if (msg.key.fromMe) return;

  const jid = msg.key.remoteJid;

  // Extract text from various message types
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';

  if (!text.trim()) return;

  console.log(`Incoming [${jid}]: ${text}`);

  const rules = loadRules();
  const matchedRule = matchRule(text, rules);

  if (matchedRule) {
    console.log(`Rule matched: ${matchedRule.id}`);
    await sock.sendMessage(jid, { text: matchedRule.response });
    return;
  }

  // No rule matched — fall back to AI
  try {
    const aiReply = await getAIResponse(jid, text);
    console.log(`AI reply to [${jid}]: ${aiReply.slice(0, 80)}...`);
    await sock.sendMessage(jid, { text: aiReply });
  } catch (err) {
    console.error('AI response error:', err.message);
    await sock.sendMessage(jid, {
      text: "I'm sorry, I'm having trouble responding right now. Please try again later.",
    });
  }
}

// ─── Baileys Connection ───────────────────────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
  });

  sockInstance = sock;
  connectionStatus = 'connecting';

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const url = await QRCode.toDataURL(qr);
        cachedQR = url;
        qrTimestamp = Date.now();
        console.log('QR cached at ' + new Date().toISOString());
      } catch (err) {
        console.error('QR generation error:', err);
      }
    }

    if (connection === 'open') {
      connectionStatus = 'open';
      cachedQR = null;
      console.log('WhatsApp connected!');
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      cachedQR = null;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Disconnected. Reconnect: ' + shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      }
    }
  });

  // Listen for incoming messages
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    for (const msg of msgs) {
      await handleIncomingMessage(sock, msg).catch((err) =>
        console.error('Message handler error:', err)
      );
    }
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    connection: connectionStatus,
    uptime: Math.floor(process.uptime()),
  });
});

app.get('/api/qr', (req, res) => {
  if (connectionStatus === 'open') {
    return res.json({ status: 'open', qr: null });
  }
  const isExpired = !qrTimestamp || Date.now() - qrTimestamp > QR_MAX_AGE_MS;
  if (cachedQR && !isExpired) {
    return res.json({ status: 'pending', qr: cachedQR });
  }
  res.json({ status: 'loading', qr: null });
});

app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }
  if (connectionStatus !== 'open') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  try {
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    await sockInstance.sendMessage(jid, { text: message });
    res.json({ success: true, to: jid });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/broadcast', async (req, res) => {
  const { phones, message } = req.body;
  if (!phones?.length || !message) {
    return res.status(400).json({ error: 'phones[] and message are required' });
  }
  if (connectionStatus !== 'open') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  const results = [];
  for (const phone of phones) {
    try {
      const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      await sockInstance.sendMessage(jid, { text: message });
      results.push({ phone, status: 'sent' });
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      results.push({ phone, status: 'failed', error: err.message });
    }
  }
  res.json({ results });
});

// ─── Rule Management Routes ───────────────────────────────────────────────────

// GET /api/rules — list all rules
app.get('/api/rules', (req, res) => {
  res.json(loadRules());
});

// POST /api/rules — create a rule
// Body: { pattern: string, response: string, flags?: string }
app.post('/api/rules', (req, res) => {
  const { pattern, response, flags } = req.body;
  if (!pattern || !response) {
    return res.status(400).json({ error: 'pattern and response are required' });
  }

  // Validate regex before saving
  try {
    new RegExp(pattern, flags || 'i');
  } catch {
    return res.status(400).json({ error: 'Invalid regex pattern' });
  }

  const rules = loadRules();
  const newRule = {
    id: 'rule-' + crypto.randomUUID().split('-')[0],
    pattern,
    flags: flags || 'i',
    response,
  };
  rules.push(newRule);
  saveRules(rules);
  res.status(201).json(newRule);
});

// PUT /api/rules/:id — update a rule
app.put('/api/rules/:id', (req, res) => {
  const { pattern, response, flags } = req.body;
  const rules = loadRules();
  const idx = rules.findIndex((r) => r.id === req.params.id);

  if (idx === -1) {
    return res.status(404).json({ error: 'Rule not found' });
  }

  if (pattern) {
    try {
      new RegExp(pattern, flags || rules[idx].flags || 'i');
    } catch {
      return res.status(400).json({ error: 'Invalid regex pattern' });
    }
    rules[idx].pattern = pattern;
  }
  if (flags !== undefined) rules[idx].flags = flags;
  if (response) rules[idx].response = response;

  saveRules(rules);
  res.json(rules[idx]);
});

// DELETE /api/rules/:id — remove a rule
app.delete('/api/rules/:id', (req, res) => {
  const rules = loadRules();
  const filtered = rules.filter((r) => r.id !== req.params.id);

  if (filtered.length === rules.length) {
    return res.status(404).json({ error: 'Rule not found' });
  }

  saveRules(filtered);
  res.json({ success: true });
});

// DELETE /api/history/:jid — clear AI conversation history for a contact
app.delete('/api/history/:jid', (req, res) => {
  conversationHistory.delete(req.params.jid);
  res.json({ success: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('Warning: GEMINI_API_KEY is not set. AI responses will fail.');
    console.warn('Get a free key at: https://aistudio.google.com');
  }
  connectToWhatsApp();
});
