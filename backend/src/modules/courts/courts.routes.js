const express = require('express');
const db = require('../../config/db');

const router = express.Router();

router.get('/:facilityId/courts', async (request, response) => {
  const { facilityId } = request.params;

  if (!/^[1-9][0-9]*$/.test(facilityId)) {
    return response.status(400).json({ error: 'Mã cụm sân không hợp lệ.' });
  }

  try {
    const [courts] = await db.execute(`
      SELECT c.court_id, c.court_name, c.sport_type,
             c.price_per_hour, c.status, c.requires_approval
      FROM COURTS AS c
      JOIN FACILITIES AS f ON f.facility_id = c.facility_id
      WHERE c.facility_id = ?
        AND c.deleted_at IS NULL
        AND f.is_active = 1
        AND f.deleted_at IS NULL
      ORDER BY c.court_name, c.court_id
    `, [facilityId]);

    response.json(courts);
  } catch (error) {
    console.error('Lỗi lấy danh sách sân:', error.code || error.message);
    response.status(500).json({ error: 'Không thể lấy danh sách sân.' });
  }
});

router.get('/:facilityId/courts/:courtId/availability', async (request, response) => {
  const { facilityId, courtId } = request.params;
  const { date } = request.query;
  const positiveId = /^[1-9][0-9]*$/;

  if (!positiveId.test(facilityId) || !positiveId.test(courtId)) {
    return response.status(400).json({ error: 'Mã cụm sân hoặc mã sân không hợp lệ.' });
  }

  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return response.status(400).json({ error: 'Nhập ngày theo định dạng YYYY-MM-DD.' });
  }

  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    return response.status(400).json({ error: 'Ngày không hợp lệ.' });
  }

  try {
    const [courts] = await db.execute(`
      SELECT c.court_id, c.status, f.open_time, f.close_time, f.is_overnight
      FROM COURTS AS c
      JOIN FACILITIES AS f ON f.facility_id = c.facility_id
      WHERE c.facility_id = ? AND c.court_id = ?
        AND c.deleted_at IS NULL AND f.deleted_at IS NULL
        AND f.is_active = 1
    `, [facilityId, courtId]);

    if (courts.length === 0) {
      return response.status(404).json({ error: 'Không tìm thấy sân trong cụm sân này.' });
    }

    const [occupied] = await db.execute(`
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
    `, [courtId, date]);

    response.json({ ...courts[0], date, occupied });
  } catch (error) {
    console.error('Lỗi tra cứu lịch sân:', error.code || error.message);
    response.status(500).json({ error: 'Không thể tra cứu lịch sân.' });
  }
});
module.exports = router;