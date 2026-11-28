const { randomBytes } = require("node:crypto");
const db = require("../../config/db");
const { transferEligibility } = require("./bank-transfer");

async function createBooking({ userId, courtId, startTime, endTime }) {
  const bookingCode = randomBytes(16).toString("hex");
  const connection = await db.getConnection();

  try {
    await connection.query("SET time_zone = '+07:00'");
    await connection.execute("SET @app_user_id = ?", [userId]);
    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `
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
    `,
      [bookingCode, userId, startTime, endTime, startTime, endTime, courtId],
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return null;
    }

    const [bookings] = await connection.execute(
      `
      SELECT booking_id, booking_code, court_id, status, approval_status, total_amount,
             DATE_FORMAT(hold_expires_at, '%Y-%m-%d %H:%i:%s') AS hold_expires_at
      FROM BOOKINGS
      WHERE booking_code = ?
    `,
      [bookingCode],
    );

    await connection.commit();
    return bookings[0];
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    try {
      await connection.query("SET @app_user_id = NULL");
      connection.release();
    } catch {
      connection.destroy();
    }
  }
}

async function listBookingsByUser(userId) {
  const [bookings] = await db.execute(
    `
    SELECT b.booking_id,
           b.booking_code,
           b.court_id,
           c.court_name,
           f.facility_name,
           DATE_FORMAT(b.start_time, '%Y-%m-%d %H:%i:%s') AS start_time,
           DATE_FORMAT(b.end_time, '%Y-%m-%d %H:%i:%s') AS end_time,
           DATE_FORMAT(b.hold_expires_at, '%Y-%m-%d %H:%i:%s') AS hold_expires_at,
           b.status,
           b.approval_status
    FROM BOOKINGS AS b
    JOIN COURTS AS c ON c.court_id = b.court_id
    JOIN FACILITIES AS f ON f.facility_id = b.facility_id
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC, b.booking_id DESC
    LIMIT 50
  `,
    [userId],
  );

  return bookings;
}

async function findBookingByUser(userId, bookingId) {
  const [rows] = await db.execute(
    `SELECT b.booking_id, b.booking_code, b.status, b.approval_status,
            b.total_amount, b.paid_amount, b.remaining_amount, c.court_name, f.facility_name,
            f.owner_id, CASE WHEN ${transferEligibility} THEN 1 ELSE 0 END AS can_transfer,
            DATE_FORMAT(b.start_time, '%Y-%m-%d %H:%i:%s') AS start_time,
            DATE_FORMAT(b.end_time, '%Y-%m-%d %H:%i:%s') AS end_time,
            DATE_FORMAT(b.hold_expires_at, '%Y-%m-%d %H:%i:%s') AS hold_expires_at,
            DATE_FORMAT(LEAST(b.hold_expires_at, b.start_time), '%Y-%m-%d %H:%i:%s') AS transfer_deadline
     FROM BOOKINGS AS b
     JOIN COURTS AS c ON c.court_id = b.court_id
     JOIN FACILITIES AS f ON f.facility_id = b.facility_id
     WHERE b.user_id = ? AND b.booking_id = ?`,
    [userId, bookingId],
  );
  return rows[0] ?? null;
}

async function cancelBookingByUser({ bookingId, userId }) {
  const connection = await db.getConnection();

  try {
    await connection.query("SET time_zone = '+07:00'");
    await connection.execute("SET @app_user_id = ?", [userId]);
    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `
      UPDATE BOOKINGS
      SET status = 'Cancelled',
          cancel_reason = 'Nguoi choi huy don'
      WHERE booking_id = ?
        AND user_id = ?
        AND status = 'Pending'
        AND hold_expires_at > NOW()
        AND start_time > NOW()
    `,
      [bookingId, userId],
    );

    await connection.commit();
    return result.affectedRows === 1;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    try {
      await connection.query("SET @app_user_id = NULL");
      connection.release();
    } catch {
      connection.destroy();
    }
  }
}

async function listPendingBookingsByOwner(ownerId) {
  const [bookings] = await db.execute(
    `
    SELECT b.booking_id,
           b.booking_code,
           f.facility_name,
           c.court_name,
           DATE_FORMAT(b.start_time, '%Y-%m-%d %H:%i:%s') AS start_time,
           DATE_FORMAT(b.end_time, '%Y-%m-%d %H:%i:%s') AS end_time,
           DATE_FORMAT(b.hold_expires_at, '%Y-%m-%d %H:%i:%s') AS hold_expires_at,
           b.approval_status
    FROM BOOKINGS AS b
    JOIN FACILITIES AS f ON f.facility_id = b.facility_id
    JOIN COURTS AS c ON c.court_id = b.court_id
    WHERE f.owner_id = ?
      AND b.status = 'Pending'
      AND b.approval_status = 'Pending'
      AND b.hold_expires_at > TIMESTAMPADD(HOUR, 7, UTC_TIMESTAMP())
    ORDER BY b.hold_expires_at, b.booking_id
    LIMIT 50
  `,
    [ownerId],
  );

  return bookings;
}
async function decideBookingByOwner({ bookingId, ownerId, decision }) {
  if (decision !== "Confirmed" && decision !== "Rejected") {
    throw new TypeError("Quyết định duyệt đơn không hợp lệ.");
  }

  const connection = await db.getConnection();

  try {
    await connection.query("SET time_zone = '+07:00'");
    await connection.execute("SET @app_user_id = ?", [ownerId]);
    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();

    const [bookings] = await connection.execute(
      `
      SELECT b.court_id,
             DATE_FORMAT(b.start_time, '%Y-%m-%d %H:%i:%s') AS start_time,
             DATE_FORMAT(b.end_time, '%Y-%m-%d %H:%i:%s') AS end_time
      FROM BOOKINGS AS b
      JOIN FACILITIES AS f ON f.facility_id = b.facility_id
      WHERE b.booking_id = ?
        AND f.owner_id = ?
        AND b.status = 'Pending'
        AND b.approval_status = 'Pending'
        AND b.hold_expires_at > NOW()
        AND b.start_time > NOW()
      FOR UPDATE OF b
    `,
      [bookingId, ownerId],
    );

    if (bookings.length === 0) {
      await connection.rollback();
      return false;
    }

    const booking = bookings[0];
    if (decision === "Confirmed") {
      await connection.execute("CALL sp_lock_court_days(?, ?, ?)", [
        booking.court_id,
        booking.start_time,
        booking.end_time,
      ]);
    }

    const newStatus = decision === "Rejected" ? "Cancelled" : "Pending";
    const cancelReason = decision === "Rejected" ? "Chu san tu choi don" : null;

    const [result] = await connection.execute(
      `
      UPDATE BOOKINGS
      SET approval_status = ?, status = ?, cancel_reason = ?
      WHERE booking_id = ?
        AND hold_expires_at > NOW()
        AND start_time > NOW()
    `,
      [decision, newStatus, cancelReason, bookingId],
    );

    await connection.commit();
    return result.affectedRows === 1;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    try {
      await connection.query("SET @app_user_id = NULL");
      connection.release();
    } catch {
      connection.destroy();
    }
  }
}
async function expirePendingBookings() {
  const [result] = await db.execute(`
    UPDATE BOOKINGS
    SET status = 'Expired'
    WHERE status = 'Pending'
      AND hold_expires_at <= sports_court_booking.fn_now_vn()
  `);

  return result.affectedRows;
}
module.exports = {
  findBookingByUser,
  createBooking,
  listBookingsByUser,
  cancelBookingByUser,
  listPendingBookingsByOwner,
  decideBookingByOwner,
  expirePendingBookings,
};
