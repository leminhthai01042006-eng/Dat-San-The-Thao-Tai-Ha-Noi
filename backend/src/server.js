const express = require("express");
const session = require("express-session");
const db = require("./config/db");
const facilitiesRouter = require("./modules/facilities/facilities.routes");
const courtsRouter = require("./modules/courts/courts.routes");
const authRouter = require("./modules/auth/auth.routes");
const bookingsRouter = require("./modules/bookings/bookings.routes");
const adminRouter = require("./modules/admin/admin.routes");
const {
  expirePendingBookings,
} = require("./modules/bookings/bookings.repository");

const app = express();
const port = Number(process.env.PORT || 3000);

app.get("/api/health", async (_request, response) => {
  try {
    await db.query("SELECT 1 AS ok");
    response.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Lỗi kiểm tra MySQL:", error.code || error.message);
    response.status(503).json({ status: "error", database: "unavailable" });
  }
});
app.use(express.json());

app.use(
  session({
    name: "courtpulse.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 1000,
    },
  }),
);
app.use("/api/facilities", facilitiesRouter);
app.use("/api/facilities", courtsRouter);
app.use("/api/auth", authRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/admin", adminRouter);

async function runBookingExpiry() {
  try {
    const count = await expirePendingBookings();

    if (count > 0) {
      console.log(`Đã chuyển ${count} đơn quá hạn sang Expired.`);
    }
  } catch (error) {
    console.error("Lỗi cập nhật đơn quá hạn:", error.code || error.message);
  } finally {
    setTimeout(runBookingExpiry, 60_000).unref();
  }
}

app.listen(port, (error) => {
  if (error) {
    console.error("Không thể khởi động backend:", error);
    process.exitCode = 1;
    return;
  }

  console.log(`Backend đang chạy tại http://localhost:${port}`);
  void runBookingExpiry();
});
