const express = require('express');
const db = require('../../config/db');

const router = express.Router();

router.get('/', async (_request, response) => {
  try {
    const [facilities] = await db.query(`
      SELECT facility_id, facility_name, address, district
      FROM FACILITIES
      WHERE is_active = 1 AND deleted_at IS NULL
      ORDER BY facility_name, facility_id
    `);

    response.json(facilities);
  } catch (error) {
    console.error('Lỗi lấy danh sách cụm sân:', error.code || error.message);
    response.status(500).json({ error: 'Không thể lấy danh sách cụm sân.' });
  }
});

module.exports = router;