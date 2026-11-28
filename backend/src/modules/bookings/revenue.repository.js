const db = require("../../config/db");

async function getRevenue({ ownerId, start, end }) {
  const ownership = ownerId === null ? "" : "AND f.owner_id = ?";
  const args = ownerId === null ? [start, end] : [start, end, ownerId];
  const [transactions, bookings] = await Promise.all([
    db.execute(
      `SELECT DATE_FORMAT(p.paid_at, '%Y-%m-%d') AS day,
              SUM(CASE WHEN p.payment_type <> 'Refund' THEN p.amount ELSE 0 END) AS gross,
              SUM(CASE WHEN p.payment_type = 'Refund' THEN p.amount ELSE 0 END) AS refunded
       FROM payments AS p
       JOIN BOOKINGS AS b ON b.booking_id = p.booking_id
       JOIN FACILITIES AS f ON f.facility_id = b.facility_id
       WHERE p.paid_at >= ? AND p.paid_at < ?
         AND (p.payment_status = 'Success'
              OR (p.payment_type <> 'Refund' AND p.payment_status = 'Refunded'))
         ${ownership}
       GROUP BY day
       ORDER BY day`,
      args,
    ),
    db.execute(
      `SELECT b.status, COUNT(*) AS count
       FROM BOOKINGS AS b
       JOIN FACILITIES AS f ON f.facility_id = b.facility_id
       WHERE b.booking_date >= ? AND b.booking_date < ? ${ownership}
       GROUP BY b.status
       ORDER BY count DESC, b.status`,
      args,
    ),
  ]);
  return { transactions: transactions[0], bookings: bookings[0] };
}

module.exports = { getRevenue };
