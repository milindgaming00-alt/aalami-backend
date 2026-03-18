const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

let isReady = false;

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', waReady: isReady });
});

app.get('/api/qr', (req, res) => {
  res.json({ status: 'loading', qr: null });
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', waReady: isReady });
});

app.post('/api/send', (req, res) => {
  res.json({ success: false, error: 'WhatsApp not connected yet' });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
