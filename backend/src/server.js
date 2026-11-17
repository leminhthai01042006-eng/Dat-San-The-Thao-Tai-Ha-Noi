const express = require('express');
const session = require('express-session');
const db = require('./config/db');
const facilitiesRouter = require('./modules/facilities/facilities.routes');
const courtsRouter = require('./modules/courts/courts.routes');
const authRouter = require('./modules/auth/auth.routes');

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
app.use(express.json());

app.use(session({
  name: 'courtpulse.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 1000,
  },
}));

app.use('/api/auth', authRouter);
app.listen(port, (error) => {
  if (error) {
    console.error('Không thể khởi động backend:', error);
    process.exitCode = 1;
    return;
  }

  console.log(`Backend đang chạy tại http://localhost:${port}`);
});