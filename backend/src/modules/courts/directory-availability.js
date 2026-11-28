const db = require("../../config/db");
const { getReceivingAccount } = require("../bookings/bank-transfer");
const { findAvailableCourts } = require("./courts.repository");

const sportPrefixes = new Map([
  ["TABLE_TENNIS", "bong-ban-"], ["BADMINTON", "cau-long-"],
  ["VOLLEYBALL", "bong-chuyen-"], ["PICKLEBALL", "pickleball-"],
]);

function readLinks() {
  try {
    const values = JSON.parse(process.env.COURTPULSE_DIRECTORY_LINKS || "{}");
    return Object.entries(values).filter(([slug, id]) => (
      /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(slug) &&
      /^(?:bong-ban|cau-long|bong-chuyen|pickleball)-.+$/.test(slug) &&
      ((typeof id === "number" && Number.isSafeInteger(id)) || typeof id === "string") &&
      /^[1-9]\d{0,19}$/.test(String(id))
    ));
  } catch {
    console.error("Cấu hình liên kết danh bạ sân không hợp lệ.");
    return [];
  }
}

const links = readLinks();

async function getDirectoryAvailability({ sportType, startTime, endTime }) {
  const prefix = sportPrefixes.get(sportType);
  if (!prefix) return null;
  const matching = links.filter(([slug]) => slug.startsWith(prefix));
  if (!matching.length) return {};

  const ids = [...new Set(matching.map(([, id]) => String(id)))];
  const [facilities] = await db.execute(
    `SELECT f.facility_id, f.owner_id
     FROM FACILITIES AS f
     WHERE f.facility_id IN (${ids.map(() => "?").join(",")})
       AND f.is_active = 1 AND f.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM COURTS AS c
                   WHERE c.facility_id = f.facility_id AND c.sport_type = ? AND c.deleted_at IS NULL)`,
    [...ids, sportType],
  );
  const activeIds = facilities.map((facility) => String(facility.facility_id));
  const courts = await findAvailableCourts({ startTime, endTime, sportType, facilityIds: activeIds, includeStatus: true });

  const byFacility = new Map(await Promise.all(facilities.map(async (facility) => [
    String(facility.facility_id),
    {
      available: 0,
      occupied: 0,
      bookings: 0,
      transferAvailable: Boolean(await getReceivingAccount(facility.owner_id)),
      courts: [],
    },
  ])));
  for (const court of courts) {
    const inventory = byFacility.get(String(court.facility_id));
    const count = Number(court.booking_count);
    inventory.bookings += count;
    if (count > 0) {
      inventory.occupied++;
    } else {
      inventory.available++;
      const { facility_id, court_id, court_name, price_per_hour } = court;
      inventory.courts.push({ facility_id, court_id, court_name, price_per_hour });
    }
  }
  return Object.fromEntries(matching.flatMap(([slug, id]) => byFacility.has(String(id)) ? [[slug, byFacility.get(String(id))]] : []));
}

module.exports = { getDirectoryAvailability };
