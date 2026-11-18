const express = require("express");
const db = require("../../config/db");
const { randomBytes } = require("node:crypto");
const requireAuth = require("../../middleware/requireAuth");

const router = express.Router();

router.get("/", async (_request, response) => {
  try {
    const [facilities] = await db.query(`
      SELECT facility_id, facility_name, address, district
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
router.post("/", requireAuth, async (request, response) => {
  if (request.user.role !== "OWNER") {
    return response.status(403).json({
      error: "Chỉ chủ sân được thêm cụm sân.",
    });
  }

  const { facility_name, address, district, city, hotline } =
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
        owner_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        venueCode,
        facility_name.trim(),
        address.trim(),
        district.trim(),
        city.trim(),
        hotline.trim(),
        request.user.user_id,
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

  const isOvernight = close_time <= open_time;

  try {
    const [result] = await db.execute(
      `
      UPDATE FACILITIES
      SET facility_name = ?, address = ?, district = ?, city = ?,
          hotline = ?, open_time = ?, close_time = ?, is_overnight = ?
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
