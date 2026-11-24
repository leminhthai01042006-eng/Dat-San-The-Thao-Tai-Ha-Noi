const express = require("express");
const { randomUUID } = require("node:crypto");
const db = require("../../config/db");
const { findAvailableCourts } = require("./courts.repository");
const { getDirectoryAvailability } = require("./directory-availability");
const requireAuth = require("../../middleware/requireAuth");
const { isValidImageUrl } = require("../image-url");

const router = express.Router();

router.get("/:facilityId/courts", async (request, response) => {
  const { facilityId } = request.params;

  if (!/^[1-9][0-9]*$/.test(facilityId)) {
    return response.status(400).json({ error: "Mã cụm sân không hợp lệ." });
  }

  try {
    const [courts] = await db.execute(
      `
      SELECT c.court_id, c.court_name, c.sport_type,
             c.price_per_hour, c.status, c.requires_approval, c.image_url
      FROM COURTS AS c
      JOIN FACILITIES AS f ON f.facility_id = c.facility_id
      WHERE c.facility_id = ?
        AND c.deleted_at IS NULL
        AND f.is_active = 1
        AND f.deleted_at IS NULL
      ORDER BY c.court_name, c.court_id
    `,
      [facilityId],
    );

    response.json(courts);
  } catch (error) {
    console.error("Lỗi lấy danh sách sân:", error.code || error.message);
    response.status(500).json({ error: "Không thể lấy danh sách sân." });
  }
});

router.get(
  "/:facilityId/courts/:courtId/availability",
  async (request, response) => {
    const { facilityId, courtId } = request.params;
    const { date } = request.query;
    const positiveId = /^[1-9][0-9]*$/;

    if (!positiveId.test(facilityId) || !positiveId.test(courtId)) {
      return response
        .status(400)
        .json({ error: "Mã cụm sân hoặc mã sân không hợp lệ." });
    }

    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return response
        .status(400)
        .json({ error: "Nhập ngày theo định dạng YYYY-MM-DD." });
    }

    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== date
    ) {
      return response.status(400).json({ error: "Ngày không hợp lệ." });
    }

    try {
      const [courts] = await db.execute(
        `
      SELECT c.court_id, c.status, f.open_time, f.close_time, f.is_overnight,
             c.image_url, f.cancel_before_minutes
      FROM COURTS AS c
      JOIN FACILITIES AS f ON f.facility_id = c.facility_id
      WHERE c.facility_id = ? AND c.court_id = ?
        AND c.deleted_at IS NULL AND f.deleted_at IS NULL
        AND f.is_active = 1
    `,
        [facilityId, courtId],
      );

      if (courts.length === 0) {
        return response
          .status(404)
          .json({ error: "Không tìm thấy sân trong cụm sân này." });
      }

      const [occupied] = await db.execute(
        `
      SELECT DATE_FORMAT(start_time, '%Y-%m-%d %H:%i:%s') AS start_time,
             DATE_FORMAT(end_time, '%Y-%m-%d %H:%i:%s') AS end_time
      FROM BOOKINGS
      WHERE court_id = ?
        AND booking_date = ?
        AND is_active_slot = 1
        AND (
          status <> 'Pending'
          OR hold_expires_at > TIMESTAMPADD(HOUR, 7, UTC_TIMESTAMP())
        )
      ORDER BY start_time
    `,
        [courtId, date],
      );

      response.json({ ...courts[0], date, occupied });
    } catch (error) {
      console.error("Lỗi tra cứu lịch sân:", error.code || error.message);
      response.status(500).json({ error: "Không thể tra cứu lịch sân." });
    }
  },
);
router.patch(
  "/:facilityId/courts/:courtId/status",
  requireAuth,
  async (request, response) => {
    if (request.user.role !== "OWNER") {
      return response
        .status(403)
        .json({ error: "Chỉ chủ sân được đổi trạng thái sân." });
    }

    const { facilityId, courtId } = request.params;
    const { status } = request.body ?? {};
    const positiveId = /^[1-9][0-9]*$/;

    if (!positiveId.test(facilityId) || !positiveId.test(courtId)) {
      return response
        .status(400)
        .json({ error: "Mã cụm sân hoặc mã sân không hợp lệ." });
    }

    if (!["Available", "Maintenance", "Inactive"].includes(status)) {
      return response.status(400).json({
        error: "Vui lòng chọn một trạng thái sân hợp lệ.",
      });
    }

    try {
      const [result] = await db.execute(
        `
      UPDATE COURTS AS c
      JOIN FACILITIES AS f ON f.facility_id = c.facility_id
      SET c.status = ?
      WHERE c.facility_id = ?
        AND c.court_id = ?
        AND f.owner_id = ?
        AND c.deleted_at IS NULL
        AND f.deleted_at IS NULL
    `,
        [status, facilityId, courtId, request.user.user_id],
      );

      if (result.affectedRows === 0) {
        return response
          .status(404)
          .json({ error: "Không tìm thấy sân bạn có thể quản lý." });
      }

      return response.json({ message: "Đã cập nhật trạng thái sân.", status });
    } catch (error) {
      console.error("Lỗi đổi trạng thái sân:", error.code || error.message);
      return response
        .status(500)
        .json({ error: "Chưa thể cập nhật trạng thái sân. Vui lòng thử lại." });
    }
  },
);
router.post("/:facilityId/courts", requireAuth, async (request, response) => {
  if (request.user.role !== "OWNER") {
    return response.status(403).json({ error: "Chỉ chủ sân được thêm sân." });
  }

  const { facilityId } = request.params;
  const {
    court_name,
    sport_type,
    price_per_hour,
    requires_approval = false,
    image_url,
  } = request.body ?? {};

  if (!/^[1-9][0-9]*$/.test(facilityId)) {
    return response.status(400).json({ error: "Mã cụm sân không hợp lệ." });
  }

  const name = typeof court_name === "string" ? court_name.trim() : "";
  const sport = typeof sport_type === "string" ? sport_type.trim() : "";

  if (!name || name.length > 120 || !sport || sport.length > 30) {
    return response.status(400).json({
      error: "Vui lòng nhập tên sân hợp lệ và chọn môn thể thao.",
    });
  }

  if (
    !Number.isSafeInteger(price_per_hour) ||
    price_per_hour < 0 ||
    price_per_hour > 9_999_999_999
  ) {
    return response.status(400).json({
      error: "Vui lòng nhập giá thuê theo giờ bằng số đồng nguyên không âm.",
    });
  }

  if (typeof requires_approval !== "boolean") {
    return response.status(400).json({
      error: "Vui lòng chọn sân có cần chủ sân duyệt đơn hay không.",
    });
  }

  if (!isValidImageUrl(image_url)) {
    return response.status(400).json({ error: "Nhập URL ảnh HTTP(S) tối đa 500 ký tự." });
  }

  const courtCode = randomUUID();

  try {
    const [result] = await db.execute(
      `
      INSERT INTO COURTS (
        facility_id, sport_type, court_code, court_name,
        price_per_hour, requires_approval, image_url
      )
      SELECT facility_id, ?, ?, ?, ?, ?, ?
      FROM FACILITIES
      WHERE facility_id = ? AND owner_id = ? AND deleted_at IS NULL
    `,
      [
        sport,
        courtCode,
        name,
        price_per_hour,
        requires_approval,
        image_url?.trim() ?? null,
        facilityId,
        request.user.user_id,
      ],
    );

    if (result.affectedRows === 0) {
      return response.status(404).json({
        error: "Không tìm thấy cụm sân bạn có thể quản lý.",
      });
    }

    return response.status(201).json({
      message: "Đã thêm sân.",
      court_id: result.insertId,
      court_code: courtCode,
    });
  } catch (error) {
    if (error.code === "ER_NO_REFERENCED_ROW_2") {
      return response.status(400).json({
        error: "Môn thể thao đã chọn không có trong danh mục.",
      });
    }

    console.error("Lỗi thêm sân:", error.code || error.message);
    return response.status(500).json({
      error: "Chưa thể thêm sân. Vui lòng thử lại.",
    });
  }
});
router.put(
  "/:facilityId/courts/:courtId",
  requireAuth,
  async (request, response) => {
    if (request.user.role !== "OWNER") {
      return response
        .status(403)
        .json({ error: "Chỉ chủ sân được sửa thông tin sân." });
    }

    const { facilityId, courtId } = request.params;
    const { court_name, price_per_hour, requires_approval, image_url } =
      request.body ?? {};
    const positiveId = /^[1-9][0-9]*$/;

    if (!positiveId.test(facilityId) || !positiveId.test(courtId)) {
      return response
        .status(400)
        .json({ error: "Mã cụm sân hoặc mã sân không hợp lệ." });
    }

    const name = typeof court_name === "string" ? court_name.trim() : "";

    if (!name || name.length > 120) {
      return response
        .status(400)
        .json({ error: "Vui lòng nhập tên sân từ 1 đến 120 ký tự." });
    }

    if (
      !Number.isSafeInteger(price_per_hour) ||
      price_per_hour < 0 ||
      price_per_hour > 9_999_999_999
    ) {
      return response.status(400).json({
        error:
          "Vui lòng nhập giá thuê theo giờ bằng số nguyên từ 0 đến 9.999.999.999 đồng.",
      });
    }

    if (typeof requires_approval !== "boolean") {
      return response.status(400).json({
        error: "Vui lòng chọn sân có cần chủ sân duyệt đơn hay không.",
      });
    }

    if (!isValidImageUrl(image_url)) {
      return response.status(400).json({ error: "Nhập URL ảnh HTTP(S) tối đa 500 ký tự." });
    }

    try {
      const [result] = await db.execute(
        `
      UPDATE COURTS AS c
      JOIN FACILITIES AS f ON f.facility_id = c.facility_id
      SET c.court_name = ?, c.price_per_hour = ?, c.requires_approval = ?,
          c.image_url = IF(?, ?, c.image_url)
      WHERE c.facility_id = ?
        AND c.court_id = ?
        AND f.owner_id = ?
        AND c.deleted_at IS NULL
        AND f.deleted_at IS NULL
    `,
        [
          name,
          price_per_hour,
          requires_approval,
          image_url !== undefined,
          image_url?.trim() ?? null,
          facilityId,
          courtId,
          request.user.user_id,
        ],
      );

      if (result.affectedRows === 0) {
        return response.status(404).json({
          error: "Không tìm thấy sân bạn có thể quản lý.",
        });
      }

      return response.json({ message: "Đã cập nhật thông tin sân." });
    } catch (error) {
      console.error("Lỗi sửa thông tin sân:", error.code || error.message);
      return response.status(500).json({
        error: "Chưa thể cập nhật thông tin sân. Vui lòng thử lại.",
      });
    }
  },
);
function parseSearchTime(value) {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)
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

router.get("/search", async (request, response) => {
  const { start_time, end_time, district, sport_type, max_price, include_status, directory } =
    request.query;

  const start = parseSearchTime(start_time);
  const end = parseSearchTime(end_time);

  if (start === null || end === null) {
    return response.status(400).json({
      error: "Vui lòng nhập ngày giờ hợp lệ theo dạng YYYY-MM-DD HH:mm.",
    });
  }

  const durationMinutes = (end - start) / 60_000;

  if (start <= Date.now() || durationMinutes < 30 || durationMinutes > 720) {
    return response.status(400).json({
      error:
        "Giờ bắt đầu phải ở tương lai và thời lượng phải từ 30 phút đến 12 giờ.",
    });
  }

  if (
    (district !== undefined &&
      (typeof district !== "string" ||
        !district.trim() ||
        district.trim().length > 100)) ||
    (sport_type !== undefined &&
      (typeof sport_type !== "string" ||
        !sport_type.trim() ||
        sport_type.trim().length > 30))
  ) {
    return response.status(400).json({
      error: "Vui lòng kiểm tra lại phường và môn thể thao đã chọn.",
    });
  }

  if (
    max_price !== undefined &&
    (typeof max_price !== "string" || !/^\d{1,10}$/.test(max_price))
  ) {
    return response.status(400).json({
      error: "Vui lòng nhập giá tối đa theo giờ bằng số đồng nguyên không âm.",
    });
  }

  try {
    if (directory === "1") {
      const venues = await getDirectoryAvailability({
        startTime: `${start_time}:00`,
        endTime: `${end_time}:00`,
        sportType: sport_type?.trim(),
      });
      if (!venues) return response.status(400).json({ error: "Vui lòng chọn một môn trong danh bạ." });
      return response.json({ venues });
    }
    const courts = await findAvailableCourts({
      startTime: `${start_time}:00`,
      endTime: `${end_time}:00`,
      district: district?.trim() ?? null,
      sportType: sport_type?.trim() ?? null,
      maxPrice: max_price === undefined ? null : Number(max_price),
      includeStatus: include_status === "1",
    });

    return response.json(courts);
  } catch (error) {
    console.error("Lỗi tìm sân:", error.code || error.message);
    return response.status(500).json({
      error: "Chưa thể tìm sân. Vui lòng thử lại.",
    });
  }
});

module.exports = router;
