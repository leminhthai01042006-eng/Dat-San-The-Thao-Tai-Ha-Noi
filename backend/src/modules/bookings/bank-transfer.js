const { createHash } = require("node:crypto");
const db = require("../../config/db");

function readAccounts() {
  try {
    const configured = JSON.parse(process.env.COURTPULSE_BANK_ACCOUNTS || "{}");
    return new Map(Object.entries(configured).flatMap(([ownerId, account]) => {
      const { bank, accountNumber, accountName } = account ?? {};
      if (!/^[1-9]\d*$/.test(ownerId) || !/^\d{6,32}$/.test(accountNumber ?? "") ||
          typeof accountNumber !== "string" || typeof bank !== "string" || !bank.trim() ||
          typeof accountName !== "string" || !accountName.trim()) return [];
      return [[ownerId, { bank: bank.trim(), accountNumber, accountName: accountName.trim() }]];
    }));
  } catch {
    console.error("Cấu hình tài khoản nhận chuyển khoản không hợp lệ.");
    return new Map();
  }
}

const accounts = readAccounts();
let permissionCheck;
let permissionCheckedAt = 0;

async function getReceivingAccount(ownerId) {
  const account = accounts.get(String(ownerId));
  if (!account) return null;

  if (!permissionCheck || Date.now() - permissionCheckedAt > 30_000) {
    permissionCheckedAt = Date.now();
    // Kiểm tra quyền INSERT mà không ghi giao dịch hay kích hoạt trigger.
    permissionCheck = db.execute(
      `INSERT INTO payments (booking_id, processed_by, payment_type, payment_method,
                            amount, transaction_ref, payment_status)
       SELECT 0, NULL, 'Full_Payment', 'Bank_Transfer', 1, 'permission-check', 'Success'
       WHERE FALSE`,
    ).then(() => true).catch((error) => {
      console.error("Chưa thể bật chuyển khoản:", error.code || error.message);
      return false;
    });
  }
  return await permissionCheck ? account : null;
}

async function transferAvailableForFacility(facilityId) {
  if (!accounts.size) return false;
  const [rows] = await db.execute(
    "SELECT owner_id FROM FACILITIES WHERE facility_id = ? AND is_active = 1 AND deleted_at IS NULL",
    [facilityId],
  );
  return rows.length > 0 && Boolean(await getReceivingAccount(rows[0].owner_id));
}

const transferEligibility = `
  b.status = 'Pending'
  AND b.approval_status = 'Confirmed'
  AND LEAST(b.hold_expires_at, b.start_time) > fn_now_vn()
  AND b.remaining_amount >= 1
  AND b.remaining_amount = FLOOR(b.remaining_amount)
  AND f.is_active = 1 AND f.deleted_at IS NULL
  AND c.status = 'Available' AND c.deleted_at IS NULL
`;

async function listTransfersToReconcile(ownerId) {
  if (!await getReceivingAccount(ownerId)) return { enabled: false, bookings: [] };
  const [bookings] = await db.execute(
    `SELECT b.booking_id, CONCAT('CP', b.booking_id) AS transfer_note,
            b.remaining_amount, c.court_name, f.facility_name,
            DATE_FORMAT(LEAST(b.hold_expires_at, b.start_time), '%Y-%m-%d %H:%i:%s') AS transfer_deadline
     FROM BOOKINGS AS b
     JOIN FACILITIES AS f ON f.facility_id = b.facility_id
     JOIN COURTS AS c ON c.court_id = b.court_id
     WHERE f.owner_id = ? AND ${transferEligibility}
     ORDER BY transfer_deadline, b.booking_id`,
    [ownerId],
  );
  return { enabled: true, bookings };
}

async function confirmTransfer({ ownerId, bookingId, reference, amount }) {
  const account = await getReceivingAccount(ownerId);
  if (!account) return "disabled";
  const bankKey = account.bank.normalize("NFKC").toLowerCase().replace(/\s/g, "");
  const accountKey = createHash("sha256").update(bankKey + ":" + account.accountNumber).digest("hex").slice(0, 20);
  const transactionRef = ["BANK", accountKey, reference.toUpperCase()].join(":");
  const connection = await db.getConnection();
  try {
    await connection.query("SET time_zone = '+07:00'");
    await connection.execute("SET @app_user_id = ?", [ownerId]);
    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();
    const [bookings] = await connection.execute(
      `SELECT b.court_id,
              DATE_FORMAT(b.start_time, '%Y-%m-%d %H:%i:%s') AS start_time,
              DATE_FORMAT(b.end_time, '%Y-%m-%d %H:%i:%s') AS end_time
       FROM BOOKINGS AS b
       JOIN FACILITIES AS f ON f.facility_id = b.facility_id
       WHERE b.booking_id = ? AND f.owner_id = ?`,
      [bookingId, ownerId],
    );
    if (!bookings.length) return "not-found";

    const booking = bookings[0];
    await connection.execute("CALL sp_lock_court_days(?, ?, ?)", [
      booking.court_id, booking.start_time, booking.end_time,
    ]);
    const [status] = await connection.execute(
      `SELECT CASE WHEN ${transferEligibility} THEN 1 ELSE 0 END AS eligible,
              b.remaining_amount, b.paid_amount
       FROM BOOKINGS AS b
       JOIN FACILITIES AS f ON f.facility_id = b.facility_id
       JOIN COURTS AS c ON c.court_id = b.court_id
       WHERE b.booking_id = ? AND f.owner_id = ?
       FOR UPDATE OF b, f, c`,
      [bookingId, ownerId],
    );
    if (!status.length) return "not-found";

    const [previous] = await connection.execute(
      "SELECT booking_id, amount FROM payments WHERE transaction_ref = ?",
      [transactionRef],
    );
    if (previous.length) {
      return String(previous[0].booking_id) === bookingId && Number(previous[0].amount) === amount ? "confirmed" : "duplicate";
    }
    if (!status[0].eligible) return "closed";
    if (Number(status[0].remaining_amount) !== amount) return "wrong-amount";

    await connection.execute(
      `INSERT INTO payments (booking_id, processed_by, payment_type, payment_method,
                            amount, transaction_ref, payment_status)
       VALUES (?, ?, ?, 'Bank_Transfer', ?, ?, 'Success')`,
      [bookingId, ownerId, Number(status[0].paid_amount) > 0 ? "Remaining_Balance" : "Full_Payment", amount, transactionRef],
    );
    const [updated] = await connection.execute(
      `UPDATE BOOKINGS SET status = 'Fully_Paid'
       WHERE booking_id = ? AND status = 'Pending'
         AND LEAST(hold_expires_at, start_time) > fn_now_vn()`,
      [bookingId],
    );
    if (!updated.affectedRows) return "closed";
    await connection.commit();
    return "confirmed";
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      // A second request can acquire a different court lock for the same bank reference.
      return "duplicate";
    }
    if (error.code === "ER_LOCK_DEADLOCK" || error.code === "ER_LOCK_WAIT_TIMEOUT" || error.sqlState === "45000") return "conflict";
    throw error;
  } finally {
    try {
      await connection.rollback();
      await connection.query("SET @app_user_id = NULL");
      connection.release();
    } catch {
      connection.destroy();
    }
  }
}

module.exports = { getReceivingAccount, transferAvailableForFacility, listTransfersToReconcile, confirmTransfer, transferEligibility };
