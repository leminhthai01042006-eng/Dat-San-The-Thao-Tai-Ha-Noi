const db = require("../../config/db");

async function findAvailableCourts({
  startTime,
  endTime,
  district = null,
  sportType = null,
  maxPrice = null,
  includeStatus = false,
  facilityIds = null,
}) {
  if (facilityIds?.length === 0) return [];
  const facilityFilter = facilityIds ? "AND f.facility_id IN (" + facilityIds.map(() => "?").join(",") + ")" : "";
  const [courts] = await db.execute(
    `
    WITH requested_time AS (
      SELECT CAST(? AS DATETIME) AS starts_at,
             CAST(? AS DATETIME) AS ends_at
    ),
    matching_courts AS (
      SELECT c.court_id, c.court_name, c.sport_type, c.price_per_hour,
             c.requires_approval,
             f.facility_id, f.facility_name, f.address, f.district,
             f.open_time, f.close_time, f.is_overnight,
             r.starts_at, r.ends_at,
             CASE
               WHEN f.is_overnight = 1 AND TIME(r.starts_at) < f.open_time
                 THEN DATE_SUB(DATE(r.starts_at), INTERVAL 1 DAY)
               ELSE DATE(r.starts_at)
             END AS operating_date
      FROM COURTS AS c
      JOIN FACILITIES AS f ON f.facility_id = c.facility_id
      CROSS JOIN requested_time AS r
      WHERE c.status = 'Available'
        AND c.deleted_at IS NULL
        AND f.is_active = 1
        AND f.deleted_at IS NULL
        AND (? IS NULL OR f.district = ?)
        AND (? IS NULL OR c.sport_type = ?)
        AND (? IS NULL OR c.price_per_hour <= ?)
        ${facilityFilter}
    ),
    court_status AS (
      SELECT m.court_id, m.court_name, m.sport_type, m.price_per_hour,
             m.requires_approval, m.facility_id, m.facility_name,
             m.address, m.district,
             (SELECT COUNT(*)
              FROM BOOKINGS AS b
              WHERE b.court_id = m.court_id
                AND b.is_active_slot = 1
                AND (b.status <> 'Pending'
                     OR b.hold_expires_at > TIMESTAMPADD(HOUR, 7, UTC_TIMESTAMP()))
                AND b.start_time < m.ends_at
                AND b.end_time > m.starts_at) AS booking_count
      FROM matching_courts AS m
      WHERE m.starts_at >= TIMESTAMP(m.operating_date, m.open_time)
        AND m.ends_at <= TIMESTAMP(
          DATE_ADD(m.operating_date, INTERVAL m.is_overnight DAY),
          m.close_time
        )
    )
    SELECT *
    FROM court_status
    WHERE ? OR booking_count = 0
    ORDER BY price_per_hour, court_id
  `,
    [
      startTime,
      endTime,
      district,
      district,
      sportType,
      sportType,
      maxPrice,
      maxPrice,
      ...(facilityIds ?? []),
      includeStatus ? 1 : 0,
    ],
  );

  return includeStatus ? courts : courts.map(({ booking_count: _count, ...court }) => court);
}

module.exports = { findAvailableCourts };
