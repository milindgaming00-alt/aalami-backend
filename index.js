const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

let qrCodeData = null;
let isReady = false;
let sock = null;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr);
      isReady = false;
      console.log('QR generated');
    }
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed, reconnecting:', shouldReconnect);
      isReady = false;
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('WhatsApp connected!');
      isReady = true;
      qrCodeData = null;
    }
  });
}

connectToWhatsApp();

app.get('/', (req, res) => res.json({ status: 'ok' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', waReady: isReady });
});

app.get('/api/qr', (req, res) => {
  if (qrCodeData) {
    res.json({ qr: qrCodeData });
  } else if (isReady) {
    res.json({ status: 'connected' });
  } else {
    res.json({ status: 'loading' });
  }
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
