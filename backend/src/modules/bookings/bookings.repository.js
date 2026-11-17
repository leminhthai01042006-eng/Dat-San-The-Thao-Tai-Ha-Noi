const { randomBytes } = require('node:crypto');
const db = require('../../config/db');

async function createBooking({ userId, courtId, startTime, endTime }) {
  const bookingCode = randomBytes(16).toString('hex');
  const connection = await db.getConnection();

  try {
    await connection.query("SET time_zone = '+07:00'");
    await connection.execute('SET @app_user_id = ?', [userId]);
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await connection.beginTransaction();

    const [result] = await connection.execute(`
      INSERT INTO BOOKINGS (
        booking_code, facility_id, court_id, user_id,
        start_time, end_time, court_rental_amount
      )
      SELECT ?, c.facility_id, c.court_id, ?, ?, ?,
             ROUND(c.price_per_hour * TIMESTAMPDIFF(MINUTE, ?, ?) / 60, 2)
      FROM COURTS AS c
      JOIN FACILITIES AS f ON f.facility_id = c.facility_id
      WHERE c.court_id = ?
        AND c.status = 'Available' AND c.deleted_at IS NULL
        AND f.is_active = 1 AND f.deleted_at IS NULL
    `, [bookingCode, userId, startTime, endTime, startTime, endTime, courtId]);

    if (result.affectedRows === 0) {
      await connection.rollback();
      return null;
    }

    const [bookings] = await connection.execute(`
      SELECT booking_id, booking_code, court_id, status, approval_status,
             DATE_FORMAT(hold_expires_at, '%Y-%m-%d %H:%i:%s') AS hold_expires_at
      FROM BOOKINGS
      WHERE booking_code = ?
    `, [bookingCode]);

    await connection.commit();
    return bookings[0];
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    try {
      await connection.query('SET @app_user_id = NULL');
      connection.release();
    } catch {
      connection.destroy();
    }
  }
}

module.exports = { createBooking };