const express = require("express");
const requireAuth = require("../../middleware/requireAuth");
const { getRevenue } = require("./revenue.repository");
const {
  getReceivingAccount,
  transferAvailableForFacility,
  listTransfersToReconcile,
  confirmTransfer,
} = require("./bank-transfer");
const {
  createBooking,
  findBookingByUser,
  listBookingsByUser,
  cancelBookingByUser,
  listPendingBookingsByOwner,
  decideBookingByOwner,
} = require("./bookings.repository");

const router = express.Router();

router.get("/transfer-options/:facilityId", async (request, response) => {
  const { facilityId } = request.params;
  if (!/^[1-9]\d{0,19}$/.test(facilityId)) return response.status(400).json({ error: "Mã cụm sân không hợp lệ." });
  try {
    return response.json({ available: await transferAvailableForFacility(facilityId) });
  } catch (error) {
    console.error("Lỗi tra cứu chuyển khoản:", error.code || error.message);
    return response.status(500).json({ error: "Chưa thể kiểm tra phương thức chuyển khoản." });
  }
});

router.get("/transfers-to-reconcile", requireAuth, async (request, response) => {
  if (request.user.role !== "OWNER") return response.status(403).json({ error: "Chỉ chủ sân có thể đối soát chuyển khoản." });
  try {
    return response.json(await listTransfersToReconcile(request.user.user_id));
  } catch (error) {
    console.error("Lỗi tải danh sách đối soát:", error.code || error.message);
    return response.status(500).json({ error: "Chưa thể tải danh sách đối soát." });
  }
});

router.post("/:bookingId/confirm-transfer", requireAuth, async (request, response) => {
  if (request.user.role !== "OWNER") return response.status(403).json({ error: "Chỉ chủ sân có thể xác nhận tiền đã nhận." });
  const { bookingId } = request.params;
  const { reference, amount, verified } = request.body ?? {};
  if (!/^[1-9]\d{0,19}$/.test(bookingId) || typeof reference !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9./_-]{2,63}$/.test(reference.trim()) ||
      !Number.isSafeInteger(amount) || amount < 1 || amount > 9_999_999_999 || verified !== true) {
    return response.status(400).json({ error: "Nhập số tiền nguyên đồng, mã giao dịch ngân hàng và xác nhận đã đối chiếu." });
  }
  try {
    const result = await confirmTransfer({ bookingId, ownerId: request.user.user_id, reference: reference.trim(), amount });
    if (result === "confirmed") return response.json({ message: "Đã ghi nhận chuyển khoản và xác nhận thanh toán." });
    if (result === "disabled") return response.status(409).json({ error: "Cụm sân chưa bật nhận chuyển khoản." });
    if (result === "not-found") return response.status(404).json({ error: "Không tìm thấy đơn thuộc cụm sân của bạn." });
    const messages = {
      closed: "Đơn đã hết hiệu lực hoặc chưa đủ điều kiện. Hãy rà soát khoản tiền đã nhận với người chuyển.",
      duplicate: "Mã giao dịch này đã được ghi nhận. Hãy kiểm tra lại sao kê.",
      "wrong-amount": "Số tiền trên sao kê phải khớp với số tiền còn phải trả.",
      conflict: "Đơn vừa thay đổi hoặc khung giờ đang được xử lý. Hãy làm mới và kiểm tra lại.",
    };
    return response.status(409).json({ error: messages[result] });
  } catch (error) {
    console.error("Lỗi đối soát chuyển khoản:", error.code || error.message);
    return response.status(500).json({ error: "Chưa thể ghi nhận chuyển khoản. Vui lòng thử lại." });
  }
});

router.get("/revenue", requireAuth, async (request, response) => {
  const { role, user_id: userId } = request.user;
  if (!["OWNER", "ADMIN"].includes(role)) {
    return response.status(403).json({ error: "Tài khoản này không có quyền xem doanh thu." });
  }
  const days = request.query.days ?? "30";
  if (!["7", "30", "90"].includes(days)) {
    return response.status(400).json({ error: "Chọn khoảng thời gian 7, 30 hoặc 90 ngày." });
  }

  const day = 86_400_000;
  const vnNow = Date.now() + 7 * 3_600_000;
  const start = new Date(vnNow - (Number(days) - 1) * day).toISOString().slice(0, 10);
  const end = new Date(vnNow + day).toISOString().slice(0, 10);
  try {
    const data = await getRevenue({ ownerId: role === "OWNER" ? userId : null, start, end });
    return response.json({ start, end, ...data });
  } catch (error) {
    console.error("Lỗi lấy báo cáo doanh thu:", error.code || error.message);
    return response.status(500).json({ error: "Chưa thể tải báo cáo doanh thu." });
  }
});

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
router.get("/:bookingId/receipt", requireAuth, async (request, response) => {
  const { bookingId } = request.params;
  if (!/^[1-9][0-9]*$/.test(bookingId)) return response.status(404).json({ error: "Không tìm thấy đơn đặt sân." });

  try {
    const found = await findBookingByUser(request.user.user_id, bookingId);
    if (!found) return response.status(404).json({ error: "Không tìm thấy đơn đặt sân." });
    const { owner_id, can_transfer, transfer_deadline, ...booking } = found;
    const account = can_transfer ? await getReceivingAccount(owner_id) : null;
    const transfer = account ? {
      ...account,
      note: "CP" + booking.booking_id,
      amount: booking.remaining_amount,
      deadline: transfer_deadline,
    } : null;
    response.set("Cache-Control", "no-store");
    return response.json({ ...booking, transfer });
  } catch (error) {
    console.error("Lỗi đọc đơn đặt sân:", error.code || error.message);
    return response.status(500).json({ error: "Chưa thể đọc đơn đặt sân." });
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
router.get("/pending-approval", requireAuth, async (request, response) => {
  if (request.user.role !== "OWNER") {
    return response
      .status(403)
      .json({ error: "Chỉ chủ sân được xem đơn chờ duyệt." });
  }

  try {
    const bookings = await listPendingBookingsByOwner(request.user.user_id);
    return response.json(bookings);
  } catch (error) {
    console.error("Lỗi lấy đơn chờ duyệt:", error.code || error.message);
    return response
      .status(500)
      .json({ error: "Không thể lấy danh sách đơn chờ duyệt." });
  }
});
router.post("/:bookingId/decision", requireAuth, async (request, response) => {
  if (request.user.role !== "OWNER") {
    return response.status(403).json({ error: "Chỉ chủ sân được duyệt đơn." });
  }

  const { bookingId } = request.params;
  const { decision } = request.body ?? {};

  if (!/^[1-9][0-9]*$/.test(bookingId)) {
    return response
      .status(400)
      .json({ error: "Mã đơn phải là số nguyên dương." });
  }

  if (decision !== "Confirmed" && decision !== "Rejected") {
    return response
      .status(400)
      .json({ error: "Quyết định phải là Confirmed hoặc Rejected." });
  }

  try {
    const updated = await decideBookingByOwner({
      bookingId,
      ownerId: request.user.user_id,
      decision,
    });

    if (!updated) {
      return response
        .status(404)
        .json({ error: "Không tìm thấy đơn có thể duyệt." });
    }

    return response.json({ approval_status: decision });
  } catch (error) {
    if (error.sqlState === "45000") {
      return response.status(409).json({
        error: "Đơn hoặc khung giờ không còn đủ điều kiện để duyệt.",
      });
    }

    console.error("Lỗi duyệt đơn đặt sân:", error.code || error.message);
    return response.status(500).json({ error: "Không thể xử lý đơn đặt sân." });
  }
});
module.exports = router;
