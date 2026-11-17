const db = require('../config/db');

async function requireAuth(request, response, next) {
  const userId = request.session?.userId;

  if (!userId) {
    return response.status(401).json({ error: 'Bạn chưa đăng nhập.' });
  }

  try {
    const [users] = await db.execute(`
      SELECT user_id, full_name, email, role
      FROM USERS
      WHERE user_id = ? AND status = 'Active' AND deleted_at IS NULL
      LIMIT 1
    `, [userId]);

    if (users.length === 0) {
      return response.status(401).json({ error: 'Phiên đăng nhập không còn hợp lệ.' });
    }

    request.user = users[0];
  } catch (error) {
    console.error('Lỗi xác thực phiên:', error.code || error.message);
    return response.status(500).json({ error: 'Không thể kiểm tra phiên đăng nhập.' });
  }

  return next();
}

module.exports = requireAuth;