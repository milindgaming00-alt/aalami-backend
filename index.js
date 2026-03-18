const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

let qrCodeData = null;
let isReady = false;
let client = null;

function initClient() {
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', async (qr) => {
    console.log('QR received');
    qrCodeData = await qrcode.toDataURL(qr);
    isReady = false;
  });

  client.on('ready', () => {
    console.log('WhatsApp ready!');
    isReady = true;
    qrCodeData = null;
  });

  client.on('disconnected', () => {
    console.log('Disconnected');
    isReady = false;
    initClient();
  });

  client.initialize();
}

initClient();

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
    await client.sendMessage(`${number}@c.us`, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
