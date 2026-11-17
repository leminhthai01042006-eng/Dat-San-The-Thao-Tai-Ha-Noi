const express = require("express");
const requireAuth = require("../../middleware/requireAuth");
const {
  createBooking,
  listBookingsByUser,
  cancelBookingByUser,
} = require("./bookings.repository");

const router = express.Router();

function parseVietnamTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)
  ) {
    return null;
  }

  const dateTime = value.replace(" ", "T");
  const wallTime = new Date(`${dateTime}:00Z`);

  if (
    Number.isNaN(wallTime.getTime()) ||
    wallTime.toISOString().slice(0, 16) !== dateTime
  ) {
    return null;
  }

  return Date.parse(`${dateTime}:00+07:00`);
}

router.post("/", requireAuth, async (request, response) => {
  if (request.user.role !== "USER") {
    return response
      .status(403)
      .json({ error: "Chỉ tài khoản người chơi mới được tạo đơn." });
  }

  const { court_id, start_time, end_time } = request.body ?? {};
  const start = parseVietnamTime(start_time);
  const end = parseVietnamTime(end_time);

  if (!Number.isSafeInteger(court_id) || court_id < 1) {
    return response
      .status(400)
      .json({ error: "Mã sân phải là số nguyên dương." });
  }

  if (start === null || end === null) {
    return response
      .status(400)
      .json({ error: "Nhập thời gian theo định dạng YYYY-MM-DD HH:mm." });
  }

  const durationMinutes = (end - start) / 60000;
  if (start <= Date.now() || durationMinutes < 30 || durationMinutes > 720) {
    return response.status(400).json({
      error:
        "Giờ bắt đầu phải ở tương lai và thời lượng phải từ 30 đến 720 phút.",
    });
  }

  try {
    const booking = await createBooking({
      userId: request.user.user_id,
      courtId: court_id,
      startTime: `${start_time}:00`,
      endTime: `${end_time}:00`,
    });

    if (!booking) {
      return response
        .status(404)
        .json({ error: "Không tìm thấy sân đang nhận đặt." });
    }

    return response.status(201).json(booking);
  } catch (error) {
    if (error.sqlState === "45000") {
      const message = error.sqlMessage ?? "";
      if (message.startsWith("OVERBOOKING_CONFLICT:")) {
        return response
          .status(409)
          .json({ error: "Khung giờ này vừa được đặt. Hãy chọn giờ khác." });
      }

      return response
        .status(400)
        .json({ error: "Không thể đặt sân vào khung giờ đã chọn." });
    }

    console.error("Lỗi tạo đơn đặt sân:", error.code || error.message);
    return response.status(500).json({ error: "Không thể tạo đơn đặt sân." });
  }
});
router.get("/me", requireAuth, async (request, response) => {
  try {
    const bookings = await listBookingsByUser(request.user.user_id);
    return response.json(bookings);
  } catch (error) {
    console.error("Lỗi lấy danh sách đơn:", error.code || error.message);
    return response
      .status(500)
      .json({ error: "Không thể lấy danh sách đơn đặt sân." });
  }
});
router.post("/:bookingId/cancel", requireAuth, async (request, response) => {
  const { bookingId } = request.params;

  if (!/^[1-9][0-9]*$/.test(bookingId)) {
    return response
      .status(400)
      .json({ error: "Mã đơn phải là số nguyên dương." });
  }

  try {
    const cancelled = await cancelBookingByUser({
      bookingId,
      userId: request.user.user_id,
    });

    if (!cancelled) {
      return response
        .status(404)
        .json({ error: "Không tìm thấy đơn có thể hủy." });
    }

    return response.json({ message: "Đã hủy đơn đặt sân." });
  } catch (error) {
    console.error("Lỗi hủy đơn đặt sân:", error.code || error.message);
    return response.status(500).json({ error: "Không thể hủy đơn đặt sân." });
  }
});
module.exports = router;
