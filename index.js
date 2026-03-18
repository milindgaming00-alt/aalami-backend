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
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'open'
let sockInstance = null;
const QR_MAX_AGE_MS = 55000; // WhatsApp refreshes QR every ~60s

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

    // New QR received — convert and cache immediately
    if (qr) {
      try {
        const url = await QRCode.toDataURL(qr);
        cachedQR = url;
        qrTimestamp = Date.now();
        console.log(`[${new Date().toISOString()}] ✅ QR cached`);
      } catch (err) {
        console.error('QR generation error:', err);
      }
    }

    if (connection === 'open') {
      connectionStatus = 'open';
      cachedQR = null; // Clear QR — no longer needed
      console.log(`[${new Date().toISOString()}] 🟢 WhatsApp connected`);
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      cachedQR = null;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[${new Date().toISOString()}] 🔴 Disconnected. Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000); // Retry after 3s
      }
    }
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    connection: connectionStatus,
    uptime: Math.floor(process.uptime()),
  });
});

// QR endpoint — frontend polls this
app.get('/api/qr', (req, res) => {
  // Already connected
  if (connectionStatus === 'open') {
    return res.json({ status: 'open', qr: null });
  }

  // QR available and not expired
  const isExpired = !qrTimestamp || Date.now() - qrTimestamp > QR_MAX_AGE_MS;
  if (cachedQR && !isExpired) {
    return res.json({ status: 'pending', qr: cachedQR });
  }

  // Still waiting for QR
  res.json({ status: 'loading', qr: null });
});

// Send message
app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }

  if (connectionStatus !== 'open') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  try {
    // Format: international number + @s.whatsapp.net
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    await sockInstance.sendMessage(jid, { text: message });
    res.json({ success: true, to: jid });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Broadcast to multiple numbers
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
      // Small delay to avoid WhatsApp rate limits
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      results.push({ phone, status: 'failed', error: err.message });
    }
  }

  res.json({ results });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  connectToWhatsApp();
});
```

---

## 💬 Lovable Prompt

Paste this exactly into Lovable:
```
Update the Connection page with these changes:

1. Poll `/api/qr` (using the existing BACKEND_URL variable) every 2 seconds using setInterval inside a useEffect.

2. The endpoint returns JSON with shape: { status: "loading" | "pending" | "open", qr: string | null }
   - "loading" → show a spinner with text "Waiting for QR code..."
   - "pending" → immediately display the QR as <img src={qr} /> centered on screen, with text "Scan with WhatsApp"
   - "open" → stop polling, show a green checkmark and "WhatsApp Connected!"

3. Clear the interval on component unmount to avoid memory leaks.

4. If 3 consecutive requests fail (network error), show: "Cannot reach server. Check backend."

Here is the exact polling logic to use:
useEffect(() => {
  let failures = 0;
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/qr`);
      const data = await res.json();
      setQrData(data);
      failures = 0;
      if (data.status === 'open') clearInterval(interval);
    } catch {
      failures++;
      if (failures >= 3) setError('Cannot reach server. Check backend.');
    }
  }, 2000);
  return () => clearInterval(interval);
}, []);
```

---

## 🤔 Sidenote: Supabase + Lovable Only — Possible?

**Short answer: No, not with Baileys.**

Here's why, and what your options actually are:

| Approach | Works? | Why |
|---|---|---|
| **Baileys on Supabase Edge Functions** | ❌ | Edge Functions are serverless — they die after ~30s. Baileys needs a **persistent WebSocket** open 24/7 |
| **Baileys on Supabase DB** | ❌ | Database can't run Node processes |
| **Official WhatsApp Cloud API + Supabase** | ✅ | Webhooks hit a Supabase Edge Function, messages stored in Postgres, Lovable reads it all |
| **Twilio/360dialog + Supabase** | ✅ | Same webhook model, fully serverless |

### The "Zero Backend" Architecture (if you wanted to rebuild)
```
WhatsApp Cloud API (Meta)
        ↓ webhook
Supabase Edge Function  ←→  Supabase Postgres (contacts, messages, logs)
        ↑
   Lovable frontend (reads/writes via Supabase JS client)
