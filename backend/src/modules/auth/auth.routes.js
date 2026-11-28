const express = require("express");
const bcrypt = require("bcrypt");
const db = require("../../config/db");
const requireAuth = require("../../middleware/requireAuth");

const router = express.Router();

router.post("/login", async (request, response) => {
  const { email, password } = request.body ?? {};

  if (
    typeof email !== "string" ||
    email.trim().length === 0 ||
    email.trim().length > 150 ||
    typeof password !== "string" ||
    password.length === 0 ||
    Buffer.byteLength(password, "utf8") > 72
  ) {
    return response
      .status(400)
      .json({ error: "Email hoặc mật khẩu không hợp lệ." });
  }

  try {
    const [users] = await db.execute(
      `
      SELECT user_id, full_name, email, role, password_hash
      FROM USERS
      WHERE email = ? AND status = 'Active' AND deleted_at IS NULL
      LIMIT 1
    `,
      [email.trim()],
    );

    const user = users[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return response
        .status(401)
        .json({ error: "Email hoặc mật khẩu không đúng." });
    }

    return request.session.regenerate((regenerateError) => {
      if (regenerateError) {
        console.error("Lỗi tạo phiên:", regenerateError);
        return response
          .status(500)
          .json({ error: "Không thể tạo phiên đăng nhập." });
      }

      request.session.userId = user.user_id;

      return request.session.save((saveError) => {
        if (saveError) {
          console.error("Lỗi lưu phiên:", saveError);
          return response
            .status(500)
            .json({ error: "Không thể lưu phiên đăng nhập." });
        }

        return response.json({
          user_id: user.user_id,
          full_name: user.full_name,
          email: user.email,
          role: user.role,
        });
      });
    });
  } catch (error) {
    console.error("Lỗi kiểm tra đăng nhập:", error.code || error.message);
    return response.status(500).json({ error: "Không thể xử lý đăng nhập." });
  }
});
router.get("/me", requireAuth, (request, response) => {
  return response.json(request.user);
});
router.post("/logout", (request, response) => {
  request.session.destroy((error) => {
    if (error) {
      console.error("Lỗi hủy phiên đăng nhập:", error);
      return response.status(500).json({ error: "Không thể đăng xuất." });
    }

    response.clearCookie("courtpulse.sid", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });

    return response.json({ message: "Đã đăng xuất." });
  });
});
router.post("/register", async (request, response) => {
  const { full_name, email, phone, password } = request.body ?? {};

  const fullName = typeof full_name === "string" ? full_name.trim() : "";
  const normalizedEmail =
    typeof email === "string" ? email.trim().toLowerCase() : "";
  const phoneNumber = typeof phone === "string" ? phone.trim() : "";

  if (fullName.length === 0 || fullName.length > 120) {
    return response
      .status(400)
      .json({ error: "Họ tên phải có từ 1 đến 120 ký tự." });
  }

  if (
    normalizedEmail.length > 150 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
  ) {
    return response.status(400).json({ error: "Email không hợp lệ." });
  }

  if (!/^(?:0|\+84)[35789][0-9]{8}$/.test(phoneNumber)) {
    return response
      .status(400)
      .json({ error: "Số điện thoại di động Việt Nam không hợp lệ." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return response.status(400).json({
      error: "Vui lòng nhập mật khẩu có ít nhất 8 ký tự.",
    });
  }

  if (Buffer.byteLength(password, "utf8") > 72) {
    return response.status(400).json({
      error: "Mật khẩu quá dài. Vui lòng nhập mật khẩu ngắn hơn.",
    });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);

    await db.execute(
      `
      INSERT INTO USERS (full_name, email, phone, password_hash)
      VALUES (?, ?, ?, ?)
    `,
      [fullName, normalizedEmail, phoneNumber, passwordHash],
    );

    return response.status(201).json({ message: "Đăng ký thành công." });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return response
        .status(409)
        .json({ error: "Email hoặc số điện thoại đã được sử dụng." });
    }

    console.error("Lỗi đăng ký:", error.code || error.message);
    return response.status(500).json({ error: "Không thể tạo tài khoản." });
  }
});
module.exports = router;
