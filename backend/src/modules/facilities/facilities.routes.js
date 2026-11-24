const express = require("express");
const db = require("../../config/db");
const { randomBytes } = require("node:crypto");
const requireAuth = require("../../middleware/requireAuth");
const { isValidImageUrl } = require("../image-url");

const router = express.Router();

function isValidCancellationWindow(value) {
  return value === undefined || (Number.isInteger(value) && value >= 0 && value <= 10080);
}

router.get("/", async (_request, response) => {
  try {
    const [facilities] = await db.query(`
      SELECT facility_id, facility_name, address, district, image_url, cancel_before_minutes
      FROM FACILITIES
      WHERE is_active = 1 AND deleted_at IS NULL
      ORDER BY facility_name, facility_id
    `);

    response.json(facilities);
  } catch (error) {
    console.error("Lỗi lấy danh sách cụm sân:", error.code || error.message);
    response.status(500).json({ error: "Không thể lấy danh sách cụm sân." });
  }
});
router.get("/sports", async (_request, response) => {
  try {
    const [sports] = await db.query(
      "SELECT sport_code, name FROM sports WHERE is_active = 1 ORDER BY name, sport_code",
    );
    return response.json(sports);
  } catch (error) {
    console.error("Lỗi lấy danh sách môn thể thao:", error.code || error.message);
    return response.status(500).json({ error: "Không thể lấy danh sách môn thể thao." });
  }
});

router.get("/court-counts", async (_request, response) => {
  try {
    const [sports] = await db.query(`
      SELECT s.sport_code, s.name, COUNT(f.facility_id) AS court_count
      FROM sports s
      LEFT JOIN COURTS c ON c.sport_type = s.sport_code
        AND c.deleted_at IS NULL
      LEFT JOIN FACILITIES f ON f.facility_id = c.facility_id
        AND f.is_active = 1 AND f.deleted_at IS NULL
      WHERE s.is_active = 1
      GROUP BY s.sport_code, s.name
      ORDER BY court_count DESC, s.name, s.sport_code
    `);
    return response.json({
      total: sports.reduce((sum, sport) => sum + Number(sport.court_count), 0),
      sports,
    });
  } catch (error) {
    console.error("Lỗi thống kê sân theo môn:", error.code || error.message);
    return response.status(500).json({ error: "Chưa thể tải số liệu sân. Bấm lại để thử." });
  }
});

router.get("/court-occupancy", async (_request, response) => {
  try {
    const [[counts]] = await db.query(`
      WITH current_time_vn AS (
        SELECT TIMESTAMPADD(HOUR, 7, UTC_TIMESTAMP()) AS current_at
      )
      SELECT COUNT(*) AS total, COUNT(CASE WHEN EXISTS (
        SELECT 1 FROM BOOKINGS b
        WHERE b.court_id = c.court_id
          AND b.is_active_slot = 1
          AND (b.status <> 'Pending' OR b.hold_expires_at > t.current_at)
          AND b.start_time <= t.current_at AND b.end_time > t.current_at
      ) THEN 1 END) AS occupied
      FROM COURTS c
      JOIN FACILITIES f ON f.facility_id = c.facility_id
      JOIN sports s ON s.sport_code = c.sport_type
      CROSS JOIN current_time_vn t
      WHERE c.deleted_at IS NULL AND c.status = 'Available'
        AND f.is_active = 1 AND f.deleted_at IS NULL AND s.is_active = 1
    `);
    const total = Number(counts.total);
    const occupied = Number(counts.occupied);
    response.set("Cache-Control", "no-store");
    return response.json({ total, occupied, available: total - occupied });
  } catch (error) {
    console.error("Lỗi thống kê tình trạng sân:", error.code || error.message);
    return response.status(500).json({ error: "Chưa thể tải tình trạng sân. Bấm lại để thử." });
  }
});

router.get("/mine", requireAuth, async (request, response) => {
  if (request.user.role !== "OWNER") {
    return response.status(403).json({
      error: "Chỉ chủ sân được xem danh sách cụm sân của mình.",
    });
  }

  try {
    const [facilities] = await db.execute(
      `SELECT facility_id, facility_name, address, district, city, hotline,
              open_time, close_time, is_overnight, is_active, image_url, cancel_before_minutes
       FROM FACILITIES
       WHERE owner_id = ? AND deleted_at IS NULL
       ORDER BY facility_name, facility_id`,
      [request.user.user_id],
    );
    return response.json(facilities);
  } catch (error) {
    console.error("Lỗi lấy danh sách cụm sân của chủ sân:", error.code || error.message);
    return response.status(500).json({ error: "Không thể lấy danh sách cụm sân." });
  }
});

router.post("/", requireAuth, async (request, response) => {
  if (request.user.role !== "OWNER") {
    return response.status(403).json({
      error: "Chỉ chủ sân được thêm cụm sân.",
    });
  }

  const { facility_name, address, district, city, hotline, image_url, cancel_before_minutes } =
    request.body ?? {};

  const fields = [
    [facility_name, 150],
    [address, 255],
    [district, 100],
    [city, 100],
  ];

  const invalidField = fields.some(
    ([value, maxLength]) =>
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.trim().length > maxLength,
  );

  if (invalidField) {
    return response.status(400).json({
      error:
        "Vui lòng điền đầy đủ tên cụm sân, địa chỉ, phường và thành phố (tỉnh).",
    });
  }

  if (typeof hotline !== "string" || !/^\+?[0-9]{8,15}$/.test(hotline.trim())) {
    return response.status(400).json({
      error: "Vui lòng nhập số điện thoại liên hệ hợp lệ.",
    });
  }

  if (!isValidImageUrl(image_url) || !isValidCancellationWindow(cancel_before_minutes)) {
    return response.status(400).json({
      error: "Nhập URL ảnh HTTP(S) tối đa 500 ký tự và hạn hủy từ 0 đến 10080 phút.",
    });
  }

  const venueCode = `FAC-${randomBytes(10).toString("hex")}`;

  try {
    const [result] = await db.execute(
      `
      INSERT INTO FACILITIES (
        venue_code,
        facility_name,
        address,
        district,
        city,
        hotline,
        owner_id,
        image_url,
        cancel_before_minutes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, DEFAULT(cancel_before_minutes)))
    `,
      [
        venueCode,
        facility_name.trim(),
        address.trim(),
        district.trim(),
        city.trim(),
        hotline.trim(),
        request.user.user_id,
        image_url?.trim() ?? null,
        cancel_before_minutes ?? null,
      ],
    );

    return response.status(201).json({
      message: "Đã thêm cụm sân.",
      facility_id: result.insertId,
      venue_code: venueCode,
    });
  } catch (error) {
    console.error("Lỗi thêm cụm sân:", error.code || error.message);
    return response.status(500).json({
      error: "Chưa thể thêm cụm sân. Vui lòng thử lại.",
    });
  }
});
router.put("/:facilityId", requireAuth, async (request, response) => {
  if (request.user.role !== "OWNER") {
    return response.status(403).json({
      error: "Chỉ chủ sân được sửa thông tin cụm sân.",
    });
  }

  const { facilityId } = request.params;

  if (!/^[1-9][0-9]*$/.test(facilityId)) {
    return response.status(400).json({
      error: "Mã cụm sân không hợp lệ.",
    });
  }

  const {
    facility_name,
    address,
    district,
    city,
    hotline,
    open_time,
    close_time,
    image_url,
    cancel_before_minutes,
  } = request.body ?? {};

  const fields = [
    [facility_name, 150],
    [address, 255],
    [district, 100],
    [city, 100],
  ];

  const invalidField = fields.some(
    ([value, maxLength]) =>
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.trim().length > maxLength,
  );

  if (invalidField) {
    return response.status(400).json({
      error:
        "Vui lòng điền đầy đủ tên cụm sân, địa chỉ, phường và thành phố (tỉnh).",
    });
  }

  if (typeof hotline !== "string" || !/^\+?[0-9]{8,15}$/.test(hotline.trim())) {
    return response.status(400).json({
      error: "Vui lòng nhập số điện thoại liên hệ hợp lệ.",
    });
  }

  const timePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

  if (
    typeof open_time !== "string" ||
    typeof close_time !== "string" ||
    !timePattern.test(open_time) ||
    !timePattern.test(close_time)
  ) {
    return response.status(400).json({
      error: "Vui lòng nhập giờ mở và đóng cửa theo dạng 05:00 hoặc 23:30.",
    });
  }

  if (!isValidImageUrl(image_url) || !isValidCancellationWindow(cancel_before_minutes)) {
    return response.status(400).json({
      error: "Nhập URL ảnh HTTP(S) tối đa 500 ký tự và hạn hủy từ 0 đến 10080 phút.",
    });
  }

  const isOvernight = close_time <= open_time;

  try {
    const [result] = await db.execute(
      `
      UPDATE FACILITIES
      SET facility_name = ?, address = ?, district = ?, city = ?,
          hotline = ?, open_time = ?, close_time = ?, is_overnight = ?,
          image_url = IF(?, ?, image_url),
          cancel_before_minutes = COALESCE(?, cancel_before_minutes)
      WHERE facility_id = ?
        AND owner_id = ?
        AND deleted_at IS NULL
    `,
      [
        facility_name.trim(),
        address.trim(),
        district.trim(),
        city.trim(),
        hotline.trim(),
        `${open_time}:00`,
        `${close_time}:00`,
        isOvernight,
        image_url !== undefined,
        image_url?.trim() ?? null,
        cancel_before_minutes ?? null,
        facilityId,
        request.user.user_id,
      ],
    );

    if (result.affectedRows === 0) {
      return response.status(404).json({
        error: "Không tìm thấy cụm sân bạn có thể quản lý.",
      });
    }

    return response.json({ message: "Đã cập nhật thông tin cụm sân." });
  } catch (error) {
    console.error("Lỗi sửa cụm sân:", error.code || error.message);
    return response.status(500).json({
      error: "Chưa thể cập nhật cụm sân. Vui lòng thử lại.",
    });
  }
});
module.exports = router;
