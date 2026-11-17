const express = require('express');
const db = require('./config/db');

const app = express();
const port = 3000;

app.get('/api/health', async (_request, response) => {
  try {
    await db.query('SELECT 1 AS ok');
    response.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('Lỗi kiểm tra MySQL:', error.code || error.message);
    response.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

app.listen(port, () => {
  console.log(`Backend đang chạy tại http://localhost:${port}`);
});