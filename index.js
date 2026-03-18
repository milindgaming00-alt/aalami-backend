const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', waReady: false });
});

app.get('/api/qr', (req, res) => {
  res.json({ status: 'loading' });
});

app.post('/api/send', (req, res) => {
  res.json({ success: false, error: 'Not implemented yet' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
