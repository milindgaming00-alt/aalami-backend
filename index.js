const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── State ────────────────────────────────────────────────────────────────────
let cachedQR = null;
let qrTimestamp = null;
let connectionStatus = 'disconnected';
let sockInstance = null;
const QR_MAX_AGE_MS = 55000;

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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  connectToWhatsApp();
});
