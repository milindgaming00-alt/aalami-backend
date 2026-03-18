const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

let qrCodeData = null;
let isReady = false;
let sock = null;
let lastQRTime = null;

async function connectToWhatsApp() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  
  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['Aalami', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 2000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('QR received!');
      qrCodeData = await qrcode.toDataURL(qr);
      lastQRTime = Date.now();
      isReady = false;
    }
    
    if (connection === 'close') {
      isReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Connection closed, code:', code);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(connectToWhatsApp, 3000);
      }
    }
    
    if (connection === 'open') {
      isReady = true;
      qrCodeData = null;
      console.log('WhatsApp connected!');
    }
  });
}

connectToWhatsApp().catch(err => {
  console.error('Connection error:', err);
  setTimeout(connectToWhatsApp, 3000);
});

app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', waReady: isReady }));
app.get('/api/status', (req, res) => res.json({ status: 'ok', waReady: isReady }));

app.get('/api/qr', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  if (isReady) {
    return res.json({ status: 'connected' });
  }
  if (qrCodeData) {
    return res.json({ qr: qrCodeData, timestamp: lastQRTime });
  }
  return res.json({ status: 'loading', qr: null });
});

app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body;
  if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready' });
  try {
    const number = phone.replace(/\D/g, '');
    await sock.sendMessage(`${number}@s.whatsapp.net`, { text: message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
