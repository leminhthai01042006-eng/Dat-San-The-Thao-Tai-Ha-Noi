const express = require('express');
const db = require('./config/db');
const facilitiesRouter = require('./modules/facilities/facilities.routes');
const courtsRouter = require('./modules/courts/courts.routes');

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
app.use('/api/facilities', facilitiesRouter);
app.use('/api/facilities', courtsRouter);
app.listen(port, () => {
  console.log(`Backend đang chạy tại http://localhost:${port}`);
});