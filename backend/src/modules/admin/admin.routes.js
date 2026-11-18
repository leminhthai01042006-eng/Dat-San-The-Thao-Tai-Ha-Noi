const express = require("express");
const db = require("../../config/db");
const requireAuth = require("../../middleware/requireAuth");

const router = express.Router();

router.get("/users", requireAuth, async (request, response) => {
  if (request.user.role !== "ADMIN") {
    return response.status(403).json({
      error: "Chỉ quản trị viên được xem danh sách tài khoản.",
    });
  }

  try {
    const [users] = await db.execute(`
      SELECT user_id, full_name, email, phone, role, status
      FROM USERS
      WHERE deleted_at IS NULL
      ORDER BY user_id DESC
      LIMIT 100
    `);

    return response.json(users);
  } catch (error) {
    console.error("Lỗi lấy danh sách tài khoản:", error.code || error.message);
    return response.status(500).json({
      error: "Chưa thể lấy danh sách tài khoản. Vui lòng thử lại.",
    });
  }
});
router.patch(
  "/users/:userId/status",
  requireAuth,
  async (request, response) => {
    if (request.user.role !== "ADMIN") {
      return response.status(403).json({
        error: "Chỉ quản trị viên được khóa hoặc mở khóa tài khoản.",
      });
    }

    const { userId } = request.params;
    const { status } = request.body ?? {};

    if (!/^[1-9][0-9]*$/.test(userId)) {
      return response.status(400).json({ error: "Mã tài khoản không hợp lệ." });
    }

    if (!["Locked", "Active"].includes(status)) {
      return response.status(400).json({
        error: "Vui lòng chọn khóa hoặc mở khóa tài khoản.",
      });
    }

    try {
      const [result] = await db.execute(
        `
      UPDATE USERS
      SET status = ?
      WHERE user_id = ?
        AND role <> 'ADMIN'
        AND status IN ('Active', 'Locked')
        AND deleted_at IS NULL
    `,
        [status, userId],
      );

      if (result.affectedRows === 0) {
        return response.status(404).json({
          error: "Không tìm thấy tài khoản có thể khóa hoặc mở khóa.",
        });
      }

      return response.json({
        message:
          status === "Locked" ? "Đã khóa tài khoản." : "Đã mở khóa tài khoản.",
        status,
      });
    } catch (error) {
      console.error(
        "Lỗi cập nhật trạng thái tài khoản:",
        error.code || error.message,
      );
      return response.status(500).json({
        error: "Chưa thể cập nhật tài khoản. Vui lòng thử lại.",
      });
    }
  },
);
router.patch(
  "/owners/:userId/approve",
  requireAuth,
  async (request, response) => {
    if (request.user.role !== "ADMIN") {
      return response.status(403).json({
        error: "Chỉ quản trị viên được duyệt tài khoản chủ sân.",
      });
    }

    const { userId } = request.params;
    if (!/^[1-9][0-9]*$/.test(userId)) {
      return response.status(400).json({ error: "Mã tài khoản không hợp lệ." });
    }

    try {
      const [result] = await db.execute(
        `
      UPDATE USERS
      SET status = 'Active'
      WHERE user_id = ? AND role = 'OWNER'
        AND status = 'Inactive' AND deleted_at IS NULL
    `,
        [userId],
      );

      if (result.affectedRows === 0) {
        return response.status(404).json({
          error: "Không tìm thấy tài khoản chủ sân đang chờ duyệt.",
        });
      }

      return response.json({
        message: "Đã duyệt tài khoản chủ sân.",
        status: "Active",
      });
    } catch (error) {
      console.error(
        "Lỗi duyệt tài khoản chủ sân:",
        error.code || error.message,
      );
      return response.status(500).json({ error: "Chưa thể duyệt tài khoản." });
    }
  },
);
module.exports = router;
