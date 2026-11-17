const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../../config/db');

const router = express.Router();

router.post('/login', async (request, response) => {
  const { email, password } = request.body ?? {};

  if (
    typeof email !== 'string' ||
    email.trim().length === 0 ||
    email.trim().length > 150 ||
    typeof password !== 'string' ||
    password.length === 0 ||
    Buffer.byteLength(password, 'utf8') > 72
  ) {
    return response.status(400).json({ error: 'Email hoặc mật khẩu không hợp lệ.' });
  }

  try {
    const [users] = await db.execute(`
      SELECT user_id, full_name, email, role, password_hash
      FROM USERS
      WHERE email = ? AND status = 'Active' AND deleted_at IS NULL
      LIMIT 1
    `, [email.trim()]);

    const user = users[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return response.status(401).json({ error: 'Email hoặc mật khẩu không đúng.' });
    }

 return request.session.regenerate((regenerateError) => {
  if (regenerateError) {
    console.error('Lỗi tạo phiên:', regenerateError);
    return response.status(500).json({ error: 'Không thể tạo phiên đăng nhập.' });
  }

  request.session.userId = user.user_id;

  return request.session.save((saveError) => {
    if (saveError) {
      console.error('Lỗi lưu phiên:', saveError);
      return response.status(500).json({ error: 'Không thể lưu phiên đăng nhập.' });
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
    console.error('Lỗi kiểm tra đăng nhập:', error.code || error.message);
    return response.status(500).json({ error: 'Không thể xử lý đăng nhập.' });
  }
});
router.get('/me', async (request, response) => {
  const userId = request.session?.userId;

  if (!userId) {
    return response.status(401).json({ error: 'Bạn chưa đăng nhập.' });
  }

  try {
    const [users] = await db.execute(`
      SELECT user_id, full_name, email, role
      FROM USERS
      WHERE user_id = ? AND status = 'Active' AND deleted_at IS NULL
    `, [userId]);

    if (users.length === 0) {
      return response.status(401).json({ error: 'Phiên đăng nhập không còn hợp lệ.' });
    }

    return response.json(users[0]);
  } catch (error) {
    console.error('Lỗi lấy thông tin phiên:', error.code || error.message);
    return response.status(500).json({ error: 'Không thể lấy thông tin tài khoản.' });
  }
});
router.post('/logout', (request, response) => {
  request.session.destroy((error) => {
    if (error) {
      console.error('Lỗi hủy phiên đăng nhập:', error);
      return response.status(500).json({ error: 'Không thể đăng xuất.' });
    }

    response.clearCookie('courtpulse.sid', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    });

    return response.json({ message: 'Đã đăng xuất.' });
  });
});
module.exports = router;