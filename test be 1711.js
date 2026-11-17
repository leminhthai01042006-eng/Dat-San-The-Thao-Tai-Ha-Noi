const express = require('express');
const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-user-id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sports_court_booking',
  timezone: '+07:00'
};

let mysqlPool = null;

async function initDatabase() {
  try {
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({
      ...dbConfig,
      waitForConnections: true,
      connectionLimit: 10
    });
    const conn = await pool.getConnection();
    await conn.query("SET time_zone = '+07:00'");
    conn.release();
    mysqlPool = pool;
    console.log(`Connected to MySQL database: ${dbConfig.database}`);
  } catch (err) {
    mysqlPool = null;
    console.log('MySQL not connected, running in In-Memory mode (sports_court_booking v3 schema).');
  }
}

async function withTransaction(appUserId, callback, maxRetries = 3) {
  if (!mysqlPool) {
    return callback(null);
  }
  let attempt = 0;
  while (true) {
    const conn = await mysqlPool.getConnection();
    try {
      await conn.query("SET time_zone = '+07:00'");
      await conn.query('SET @app_user_id = ?', [appUserId ? Number(appUserId) : null]);
      await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await conn.beginTransaction();
      const result = await callback(conn);
      await conn.commit();
      conn.release();
      return result;
    } catch (err) {
      await conn.rollback();
      conn.release();
      if ((err.errno === 1213 || err.errno === 1205) && attempt < maxRetries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 50 * attempt));
        continue;
      }
      throw err;
    }
  }
}

const USERS = [];
const VENUES = [];
const SPORTS = [];
const COURTS = [];
const PRICING_RULES = [];
const BOOKINGS = [];
const SERVICES = [];
const BOOKING_ADDONS = [];
const PAYMENTS = [];
const BOOKING_AUDIT_LOGS = [];

const nextIds = {
  user: 1,
  venue: 1,
  sport: 1,
  court: 1,
  rule: 1,
  booking: 1,
  service: 1,
  addon: 1,
  payment: 1,
  audit: 1
};

const courtLocks = new Set();

function nowVnDate() {
  return new Date(Date.now() + 7 * 3600 * 1000);
}

function nowVnSql() {
  return nowVnDate().toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeRole(roleInput) {
  const r = String(roleInput || 'Customer').trim().toUpperCase();
  if (r === 'ADMIN') return 'Admin';
  if (r === 'OWNER' || r === 'STAFF') return 'Staff';
  if (r === 'USER' || r === 'CUSTOMER') return 'Customer';
  return null;
}

function normalizeUserStatus(statusInput) {
  const s = String(statusInput || 'Active').trim().toUpperCase();
  if (s === 'ACTIVE') return 'Active';
  if (s === 'LOCKED') return 'Locked';
  if (s === 'INACTIVE' || s === 'PENDING' || s === 'PENDING_APPROVAL') return 'Inactive';
  return null;
}

function normalizeCourtStatus(statusInput) {
  const s = String(statusInput || 'Available').trim().toUpperCase();
  if (s === 'AVAILABLE') return 'Available';
  if (s === 'MAINTENANCE') return 'Maintenance';
  if (s === 'INACTIVE') return 'Inactive';
  return null;
}

function normalizePhoneVn(rawPhone, fallbackIndex = 1) {
  if (!rawPhone) {
    return `09${String(10000000 + (fallbackIndex % 89999999)).slice(0, 8)}`;
  }
  let cleaned = String(rawPhone).trim().replace(/[ .-]/g, '');
  if (cleaned.startsWith('+84')) {
    cleaned = '0' + cleaned.slice(3);
  }
  if (!/^(0)(3|5|7|8|9)[0-9]{8}$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function parseDateTime(inputDateTime, dateOnly, timeOnly) {
  let raw = inputDateTime;
  if (!raw && dateOnly && timeOnly) {
    const cleanTime = String(timeOnly).length === 5 ? `${timeOnly}:00` : timeOnly;
    raw = `${dateOnly}T${cleanTime}`;
  }
  if (!raw) return null;
  const normalized = String(raw).trim().replace(' ', 'T');
  const fullIso = normalized.length === 16 ? `${normalized}:00` : normalized;
  const dt = new Date(fullIso);
  if (Number.isNaN(dt.getTime())) return null;
  return {
    isoString: fullIso.slice(0, 19),
    sqlString: fullIso.slice(0, 19).replace('T', ' '),
    dateObj: dt
  };
}

function timeToMinutes(t) {
  const parts = String(t || '00:00:00').split(':');
  return Number(parts[0]) * 60 + Number(parts[1] || 0);
}

function writeMemoryAudit(bookingId, actionType, oldStatus, newStatus, oldPayload, newPayload, changedBy) {
  BOOKING_AUDIT_LOGS.push({
    audit_id: nextIds.audit++,
    booking_id: Number(bookingId),
    action_type: actionType,
    old_status: oldStatus || null,
    new_status: newStatus || null,
    old_payload: oldPayload || null,
    new_payload: newPayload || null,
    changed_by: changedBy ? Number(changedBy) : null,
    db_user: 'in_memory_app',
    created_at: new Date().toISOString()
  });
}

function recomputeMemoryBookingTotals(booking) {
  const addonsTotal = BOOKING_ADDONS.filter((a) => a.booking_id === booking.booking_id).reduce(
    (sum, a) => sum + Number(a.line_total),
    0
  );
  const paidTotal = PAYMENTS.filter(
    (p) => p.booking_id === booking.booking_id && p.payment_type !== 'Refund' && ['Success', 'Refunded'].includes(p.payment_status)
  ).reduce((sum, p) => sum + Number(p.amount), 0);
  const refundedTotal = PAYMENTS.filter(
    (p) => p.booking_id === booking.booking_id && p.payment_type === 'Refund' && p.payment_status === 'Success'
  ).reduce((sum, p) => sum + Number(p.amount), 0);

  booking.addons_amount = Number(addonsTotal.toFixed(2));
  booking.paid_amount = Number(paidTotal.toFixed(2));
  booking.refunded_amount = Number(refundedTotal.toFixed(2));
  const netCost = Math.max(booking.court_rental_amount + booking.addons_amount - booking.discount_amount, 0);
  const netPaid = booking.paid_amount - booking.refunded_amount;
  booking.total_amount = Number(netCost.toFixed(2));
  booking.remaining_amount = Number(Math.max(netCost - netPaid, 0).toFixed(2));
  booking.overpaid_amount = Number(Math.max(netPaid - netCost, 0).toFixed(2));
  booking.is_active_slot = ['Pending', 'Deposit_Paid', 'Fully_Paid', 'Completed'].includes(booking.status) ? 1 : 0;
}

async function getUserById(userId) {
  if (mysqlPool) {
    const [rows] = await mysqlPool.query('SELECT * FROM users WHERE user_id = ? AND deleted_at IS NULL', [Number(userId)]);
    return rows[0] || null;
  }
  return USERS.find((u) => u.user_id === Number(userId) && !u.deleted_at) || null;
}

async function getOrCreateSport(sportId, sportNameOrType, conn = null) {
  if (sportId) {
    if (mysqlPool) {
      const executor = conn || mysqlPool;
      const [rows] = await executor.query('SELECT * FROM sports WHERE sport_id = ?', [Number(sportId)]);
      return rows[0] || null;
    }
    return SPORTS.find((s) => s.sport_id === Number(sportId)) || null;
  }

  const name = String(sportNameOrType || 'Cầu lông').trim();
  const code = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toUpperCase()
    .slice(0, 25);

  if (mysqlPool) {
    const executor = conn || mysqlPool;
    const [existing] = await executor.query('SELECT * FROM sports WHERE sport_code = ? OR LOWER(name) = LOWER(?)', [code, name]);
    if (existing[0]) return existing[0];
    const [res] = await executor.query(
      'INSERT INTO sports (sport_code, name, default_slot_minutes, is_active) VALUES (?, ?, 60, 1)',
      [code, name]
    );
    const [created] = await executor.query('SELECT * FROM sports WHERE sport_id = ?', [res.insertId]);
    return created[0];
  }

  let sport = SPORTS.find((s) => s.sport_code === code || s.name.toLowerCase() === name.toLowerCase());
  if (!sport) {
    sport = {
      sport_id: nextIds.sport++,
      sport_code: code,
      name,
      default_slot_minutes: 60,
      is_active: 1
    };
    SPORTS.push(sport);
  }
  return sport;
}

async function getCourtDetailed(courtId, conn = null) {
  if (mysqlPool) {
    const executor = conn || mysqlPool;
    const [rows] = await executor.query(
      `SELECT c.*, s.name AS sport_name, s.sport_code, s.default_slot_minutes,
              v.name AS venue_name, v.venue_code, v.district, v.city, v.address,
              v.open_time, v.close_time, v.is_overnight, v.manager_id, v.is_active AS venue_is_active,
              u.full_name AS manager_name
       FROM courts c
       JOIN venues v ON c.venue_id = v.venue_id
       JOIN sports s ON c.sport_id = s.sport_id
       JOIN users u ON v.manager_id = u.user_id
       WHERE c.court_id = ? AND c.deleted_at IS NULL`,
      [Number(courtId)]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      ...r,
      base_price_per_hour: Number(r.base_price_per_hour),
      price_per_hour: Number(r.base_price_per_hour),
      court_name: r.name,
      sport_type: r.sport_name,
      facility_id: r.venue_id,
      facility_name: r.venue_name,
      owner_id: r.manager_id
    };
  }

  const court = COURTS.find((c) => c.court_id === Number(courtId) && !c.deleted_at);
  if (!court) return null;
  const venue = VENUES.find((v) => v.venue_id === court.venue_id) || {};
  const sport = SPORTS.find((s) => s.sport_id === court.sport_id) || {};
  const manager = USERS.find((u) => u.user_id === venue.manager_id) || {};
  return {
    ...court,
    sport_name: sport.name || null,
    sport_code: sport.sport_code || null,
    default_slot_minutes: sport.default_slot_minutes || 60,
    venue_name: venue.name || null,
    venue_code: venue.venue_code || null,
    district: venue.district || null,
    city: venue.city || null,
    address: venue.address || null,
    open_time: venue.open_time || '05:00:00',
    close_time: venue.close_time || '23:30:00',
    is_overnight: venue.is_overnight || 0,
    manager_id: venue.manager_id || null,
    venue_is_active: venue.is_active ?? 1,
    manager_name: manager.full_name || null,
    price_per_hour: Number(court.base_price_per_hour),
    court_name: court.name,
    sport_type: sport.name || null,
    facility_id: court.venue_id,
    facility_name: venue.name || null,
    owner_id: venue.manager_id || null
  };
}

async function findConflicts(courtId, startSql, endSql, excludeBookingId = null, conn = null) {
  if (mysqlPool) {
    const executor = conn || mysqlPool;
    const params = [Number(courtId), endSql, startSql];
    let sql = `
      SELECT * FROM bookings
      WHERE court_id = ?
        AND is_active_slot = 1
        AND (status <> 'Pending' OR hold_expires_at > fn_now_vn())
        AND start_at < ?
        AND end_at > ?
    `;
    if (excludeBookingId) {
      sql += ' AND booking_id <> ?';
      params.push(Number(excludeBookingId));
    }
    const [rows] = await executor.query(sql, params);
    return rows;
  }

  const newStartMs = new Date(startSql.replace(' ', 'T')).getTime();
  const newEndMs = new Date(endSql.replace(' ', 'T')).getTime();
  const nowMs = Date.now();

  return BOOKINGS.filter((b) => {
    if (b.court_id !== Number(courtId)) return false;
    if (excludeBookingId && b.booking_id === Number(excludeBookingId)) return false;
    if (!['Pending', 'Deposit_Paid', 'Fully_Paid', 'Completed'].includes(b.status)) return false;
    if (b.status === 'Pending' && b.hold_expires_at && new Date(b.hold_expires_at).getTime() <= nowMs) {
      return false;
    }
    const oldStartMs = new Date(String(b.start_at).replace(' ', 'T')).getTime();
    const oldEndMs = new Date(String(b.end_at).replace(' ', 'T')).getTime();
    return newStartMs < oldEndMs && newEndMs > oldStartMs;
  });
}

async function requireAuth(req, res, next) {
  try {
    const rawUserId =
      req.headers['x-user-id'] ||
      (req.query && req.query.current_user_id) ||
      (req.body && req.body.current_user_id);

    if (!rawUserId) {
      return res.status(401).json({
        success: false,
        message: 'Thiếu thông tin xác thực (truyền header "x-user-id").'
      });
    }

    const user = await getUserById(rawUserId);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: `Không tìm thấy tài khoản với user_id = ${rawUserId}.`
      });
    }

    if (user.status !== 'Active') {
      return res.status(403).json({
        success: false,
        message: `Tài khoản hiện không khả dụng (status: ${user.status}).`
      });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...allowedRoles) {
  const normalizedAllowed = allowedRoles.map((r) => normalizeRole(r));
  return (req, res, next) => {
    if (!req.user || !normalizedAllowed.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Chức năng này yêu cầu quyền: ${normalizedAllowed.join(' hoặc ')}.`
      });
    }
    next();
  };
}

app.get('/api/health', async (req, res, next) => {
  try {
    if (mysqlPool) {
      const [[u]] = await mysqlPool.query('SELECT COUNT(*) AS cnt FROM users WHERE deleted_at IS NULL');
      const [[v]] = await mysqlPool.query('SELECT COUNT(*) AS cnt FROM venues WHERE deleted_at IS NULL');
      const [[c]] = await mysqlPool.query('SELECT COUNT(*) AS cnt FROM courts WHERE deleted_at IS NULL');
      const [[b]] = await mysqlPool.query('SELECT COUNT(*) AS cnt FROM bookings');
      return res.json({
        success: true,
        storage_mode: 'MYSQL_COURTPULSE_V3',
        summary: {
          total_users: u.cnt,
          total_venues: v.cnt,
          total_facilities: v.cnt,
          total_courts: c.cnt,
          total_bookings: b.cnt
        }
      });
    }
    res.json({
      success: true,
      storage_mode: 'IN_MEMORY_COURTPULSE_V3',
      summary: {
        total_users: USERS.filter((u) => !u.deleted_at).length,
        total_venues: VENUES.filter((v) => !v.deleted_at).length,
        total_facilities: VENUES.filter((v) => !v.deleted_at).length,
        total_courts: COURTS.filter((c) => !c.deleted_at).length,
        total_bookings: BOOKINGS.length
      }
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { full_name, email, username, phone, password, password_hash, role, status } = req.body;
    const finalEmail = String(email || (username && username.includes('@') ? username : `${username || ''}@courtpulse.vn`)).trim();

    if (!full_name || ! (email || username)) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng cung cấp đầy đủ full_name và email (hoặc username).'
      });
    }

    const finalRole = normalizeRole(role || 'Customer');
    if (!finalRole) {
      return res.status(400).json({
        success: false,
        message: 'role chỉ nhận Customer (USER), Staff (OWNER) hoặc Admin (ADMIN).'
      });
    }

    const finalStatus = normalizeUserStatus(status || 'Active') || 'Active';
    const finalPhone = normalizePhoneVn(phone, nextIds.user);
    if (!finalPhone) {
      return res.status(400).json({
        success: false,
        message: 'Số điện thoại không đúng chuẩn Việt Nam (03/05/07/08/09 + 8 chữ số).'
      });
    }

    const finalPassHash = String(password_hash || password || '123456');

    if (mysqlPool) {
      const [dup] = await mysqlPool.query(
        'SELECT user_id FROM users WHERE (email = ? OR phone_norm = ?) AND deleted_at IS NULL',
        [finalEmail, finalPhone]
      );
      if (dup.length > 0) {
        return res.status(409).json({ success: false, message: 'Email hoặc số điện thoại đã được sử dụng.' });
      }
      const [result] = await mysqlPool.query(
        'INSERT INTO users (full_name, email, phone, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)',
        [String(full_name).trim(), finalEmail, finalPhone, finalPassHash, finalRole, finalStatus]
      );
      const created = await getUserById(result.insertId);
      return res.status(201).json({
        success: true,
        message: 'Đăng ký tài khoản thành công.',
        data: created
      });
    }

    if (USERS.some((u) => !u.deleted_at && (u.email.toLowerCase() === finalEmail.toLowerCase() || u.phone === finalPhone))) {
      return res.status(409).json({ success: false, message: 'Email hoặc số điện thoại đã được sử dụng.' });
    }

    const newUser = {
      user_id: nextIds.user++,
      full_name: String(full_name).trim(),
      email: finalEmail,
      phone: finalPhone,
      phone_norm: finalPhone,
      password_hash: finalPassHash,
      role: finalRole,
      status: finalStatus,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null
    };

    USERS.push(newUser);
    res.status(201).json({
      success: true,
      message: 'Đăng ký tài khoản thành công.',
      data: newUser
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { email, username, phone, password, password_hash, user_id } = req.body;
    const loginKey = String(email || username || '').trim().toLowerCase();
    const normPhone = phone ? normalizePhoneVn(phone) : null;
    const pass = password_hash || password;

    let user = null;
    if (mysqlPool) {
      if (user_id) {
        user = await getUserById(user_id);
      } else {
        const [rows] = await mysqlPool.query(
          'SELECT * FROM users WHERE deleted_at IS NULL AND (LOWER(email) = ? OR phone_norm = ?)',
          [loginKey, normPhone || loginKey]
        );
        user = rows[0] || null;
      }
    } else {
      user = USERS.find(
        (u) =>
          !u.deleted_at &&
          ((user_id && u.user_id === Number(user_id)) ||
            (loginKey && (u.email.toLowerCase() === loginKey || u.email.split('@')[0].toLowerCase() === loginKey)) ||
            (normPhone && u.phone === normPhone))
      );
    }

    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản.' });
    if (pass && user.password_hash !== String(pass)) {
      return res.status(401).json({ success: false, message: 'Mật khẩu không chính xác.' });
    }
    if (user.status !== 'Active') {
      return res.status(403).json({ success: false, message: `Tài khoản đang ở trạng thái ${user.status}.` });
    }

    res.json({ success: true, message: 'Đăng nhập thành công.', data: user });
  } catch (err) {
    next(err);
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, data: req.user });
});

app.get('/api/sports', async (req, res, next) => {
  try {
    if (mysqlPool) {
      const [rows] = await mysqlPool.query('SELECT * FROM sports WHERE is_active = 1');
      return res.json({ success: true, count: rows.length, data: rows });
    }
    res.json({ success: true, count: SPORTS.length, data: SPORTS });
  } catch (err) {
    next(err);
  }
});

app.post('/api/sports', requireAuth, requireRole('Staff', 'Admin'), async (req, res, next) => {
  try {
    const { sport_code, name, default_slot_minutes = 60 } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp tên môn thể thao (name).' });
    if (![30, 45, 60, 90, 120].includes(Number(default_slot_minutes))) {
      return res.status(400).json({ success: false, message: 'default_slot_minutes chỉ nhận 30, 45, 60, 90 hoặc 120.' });
    }

    const sport = await getOrCreateSport(null, name);
    if (sport_code && !mysqlPool) sport.sport_code = String(sport_code).toUpperCase();
    res.status(201).json({ success: true, data: sport });
  } catch (err) {
    next(err);
  }
});

async function handleGetVenues(req, res, next) {
  try {
    const { district, city } = req.query;
    if (mysqlPool) {
      let sql = `
        SELECT v.*, v.venue_id AS facility_id, v.name AS facility_name, v.manager_id AS owner_id,
               u.full_name AS manager_name, COUNT(c.court_id) AS total_courts
        FROM venues v
        JOIN users u ON v.manager_id = u.user_id
        LEFT JOIN courts c ON c.venue_id = v.venue_id AND c.deleted_at IS NULL
        WHERE v.deleted_at IS NULL AND v.is_active = 1
      `;
      const params = [];
      if (district) {
        sql += ' AND LOWER(v.district) LIKE ?';
        params.push(`%${String(district).toLowerCase().trim()}%`);
      }
      if (city) {
        sql += ' AND LOWER(v.city) LIKE ?';
        params.push(`%${String(city).toLowerCase().trim()}%`);
      }
      sql += ' GROUP BY v.venue_id';
      const [rows] = await mysqlPool.query(sql, params);
      return res.json({ success: true, count: rows.length, data: rows });
    }

    let list = VENUES.filter((v) => !v.deleted_at && v.is_active).map((v) => {
      const manager = USERS.find((u) => u.user_id === v.manager_id) || {};
      const totalCourts = COURTS.filter((c) => c.venue_id === v.venue_id && !c.deleted_at).length;
      return {
        ...v,
        facility_id: v.venue_id,
        facility_name: v.name,
        owner_id: v.manager_id,
        manager_name: manager.full_name || null,
        total_courts: totalCourts
      };
    });

    if (district) {
      const kw = String(district).toLowerCase().trim();
      list = list.filter((v) => v.district.toLowerCase().includes(kw));
    }
    if (city) {
      const kw = String(city).toLowerCase().trim();
      list = list.filter((v) => v.city.toLowerCase().includes(kw));
    }

    res.json({ success: true, count: list.length, data: list });
  } catch (err) {
    next(err);
  }
}

app.get('/api/venues', handleGetVenues);
app.get('/api/facilities', handleGetVenues);

async function handleCreateVenue(req, res, next) {
  try {
    const {
      venue_code,
      name,
      facility_name,
      address,
      district,
      city = 'Hà Nội',
      hotline,
      open_time = '05:00:00',
      close_time = '23:30:00',
      is_overnight = 0
    } = req.body;

    const finalName = String(name || facility_name || '').trim();
    if (!finalName || !district) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng cung cấp tên cụm sân (name/facility_name) và quận/huyện (district).'
      });
    }

    const finalAddress = String(address || `${district}, ${city}`).trim();
    const finalHotline = String(hotline || req.user.phone || '0901234567').trim();
    const finalOpen = String(open_time).length === 5 ? `${open_time}:00` : String(open_time);
    const finalClose = String(close_time).length === 5 ? `${close_time}:00` : String(close_time);
    const overnightFlag = is_overnight ? 1 : 0;

    if (
      (overnightFlag === 0 && timeToMinutes(finalClose) <= timeToMinutes(finalOpen)) ||
      (overnightFlag === 1 && timeToMinutes(finalClose) > timeToMinutes(finalOpen))
    ) {
      return res.status(400).json({
        success: false,
        message: 'Giờ mở/đóng cửa không hợp lệ với cấu hình is_overnight (chk_venues_hours).'
      });
    }

    if (mysqlPool) {
      const code = String(venue_code || `VN-${Date.now().toString().slice(-6)}`).toUpperCase();
      const [result] = await mysqlPool.query(
        `INSERT INTO venues (venue_code, name, address, district, city, timezone, hotline, open_time, close_time, is_overnight, manager_id, is_active)
         VALUES (?, ?, ?, ?, ?, 'Asia/Ho_Chi_Minh', ?, ?, ?, ?, ?, 1)`,
        [code, finalName, finalAddress, String(district).trim(), String(city).trim(), finalHotline, finalOpen, finalClose, overnightFlag, req.user.user_id]
      );
      const [[created]] = await mysqlPool.query('SELECT * FROM venues WHERE venue_id = ?', [result.insertId]);
      return res.status(201).json({
        success: true,
        message: 'Tạo cụm sân thành công.',
        data: { ...created, facility_id: created.venue_id, facility_name: created.name, owner_id: created.manager_id }
      });
    }

    const newVenue = {
      venue_id: nextIds.venue++,
      venue_code: String(venue_code || `VN-${String(nextIds.venue - 1).padStart(3, '0')}`).toUpperCase(),
      name: finalName,
      address: finalAddress,
      district: String(district).trim(),
      city: String(city).trim(),
      timezone: 'Asia/Ho_Chi_Minh',
      hotline: finalHotline,
      open_time: finalOpen,
      close_time: finalClose,
      is_overnight: overnightFlag,
      manager_id: req.user.user_id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null
    };

    VENUES.push(newVenue);
    res.status(201).json({
      success: true,
      message: 'Tạo cụm sân thành công.',
      data: { ...newVenue, facility_id: newVenue.venue_id, facility_name: newVenue.name, owner_id: newVenue.manager_id }
    });
  } catch (err) {
    next(err);
  }
}

app.post('/api/venues', requireAuth, requireRole('Staff', 'Admin'), handleCreateVenue);
app.post('/api/owner/facilities', requireAuth, requireRole('Staff', 'Admin'), handleCreateVenue);

app.get('/api/courts', async (req, res, next) => {
  try {
    const { sport_type, sport_id, district, venue_id, facility_id, max_price, date, start_time, end_time, include_maintenance } = req.query;

    let results = [];
    if (mysqlPool) {
      const [rows] = await mysqlPool.query('SELECT court_id FROM courts WHERE deleted_at IS NULL');
      for (const r of rows) {
        const d = await getCourtDetailed(r.court_id);
        if (d) results.push(d);
      }
    } else {
      for (const c of COURTS) {
        if (!c.deleted_at) results.push(await getCourtDetailed(c.court_id));
      }
    }

    if (include_maintenance !== 'true') {
      results = results.filter((c) => c.status === 'Available' && c.venue_is_active === 1);
    }
    if (sport_id) {
      results = results.filter((c) => c.sport_id === Number(sport_id));
    }
    if (sport_type) {
      const kw = String(sport_type).toLowerCase().trim();
      results = results.filter((c) => c.sport_name && c.sport_name.toLowerCase().includes(kw));
    }
    if (venue_id || facility_id) {
      const targetVenue = Number(venue_id || facility_id);
      results = results.filter((c) => c.venue_id === targetVenue);
    }
    if (district) {
      const kw = String(district).toLowerCase().trim();
      results = results.filter((c) => c.district && c.district.toLowerCase().includes(kw));
    }
    if (max_price !== undefined && max_price !== '') {
      const maxP = Number(max_price);
      if (!Number.isNaN(maxP)) results = results.filter((c) => c.base_price_per_hour <= maxP);
    }

    if (start_time && end_time) {
      const parsedStart = parseDateTime(String(start_time).includes('T') || String(start_time).includes(' ') ? start_time : null, date, start_time);
      const parsedEnd = parseDateTime(String(end_time).includes('T') || String(end_time).includes(' ') ? end_time : null, date, end_time);

      if (!parsedStart || !parsedEnd || parsedStart.dateObj >= parsedEnd.dateObj) {
        return res.status(400).json({ success: false, message: 'Khung giờ tìm kiếm không hợp lệ.' });
      }

      const available = [];
      for (const court of results) {
        const conflicts = await findConflicts(court.court_id, parsedStart.sqlString, parsedEnd.sqlString);
        if (conflicts.length === 0) available.push(court);
      }
      results = available;
    }

    res.json({ success: true, count: results.length, data: results });
  } catch (err) {
    next(err);
  }
});

app.get('/api/courts/:courtId', async (req, res, next) => {
  try {
    const court = await getCourtDetailed(req.params.courtId);
    if (!court) return res.status(404).json({ success: false, message: 'Không tìm thấy sân.' });

    const targetDate = req.query.date || nowVnDate().toISOString().slice(0, 10);
    const activeBookings = await findConflicts(court.court_id, `${targetDate} 00:00:00`, `${targetDate} 23:59:59`);

    const openHour = Math.max(0, Number(String(court.open_time || '05:00:00').split(':')[0]));
    const closeHour = Math.min(24, Number(String(court.close_time || '23:00:00').split(':')[0]));
    const hourlySlots = [];

    for (let h = openHour; h < closeHour; h++) {
      const sStr = `${String(h).padStart(2, '0')}:00`;
      const eStr = `${String(h + 1).padStart(2, '0')}:00`;
      const conflicts = await findConflicts(court.court_id, `${targetDate} ${sStr}:00`, `${targetDate} ${eStr}:00`);
      hourlySlots.push({
        slot: `${sStr}-${eStr}`,
        start_at: `${targetDate} ${sStr}:00`,
        end_at: `${targetDate} ${eStr}:00`,
        is_available: court.status === 'Available' && conflicts.length === 0,
        holding_status: conflicts.length > 0 ? conflicts[0].status : null
      });
    }

    res.json({
      success: true,
      data: {
        ...court,
        schedule_date: targetDate,
        active_bookings: activeBookings,
        hourly_slots: hourlySlots
      }
    });
  } catch (err) {
    next(err);
  }
});

async function handleCreateCourt(req, res, next) {
  try {
    const {
      venue_id,
      facility_id,
      sport_id,
      sport_type,
      sport_name,
      court_code,
      name,
      court_name,
      base_price_per_hour,
      price_per_hour,
      status = 'Available'
    } = req.body;

    const targetVenueId = Number(venue_id || facility_id);
    const finalName = String(name || court_name || '').trim();
    const finalPrice = Number(base_price_per_hour !== undefined ? base_price_per_hour : price_per_hour);

    if (!targetVenueId || !finalName || Number.isNaN(finalPrice) || finalPrice < 0) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng cung cấp venue_id (hoặc facility_id), name (hoặc court_name) và base_price_per_hour (hoặc price_per_hour >= 0).'
      });
    }

    const sport = await getOrCreateSport(sport_id, sport_type || sport_name || 'Cầu lông');
    if (!sport) return res.status(400).json({ success: false, message: 'Môn thể thao không hợp lệ.' });

    const finalStatus = normalizeCourtStatus(status) || 'Available';

    if (mysqlPool) {
      const [[venue]] = await mysqlPool.query('SELECT * FROM venues WHERE venue_id = ? AND deleted_at IS NULL', [targetVenueId]);
      if (!venue) return res.status(404).json({ success: false, message: 'Không tìm thấy cụm sân.' });
      if (req.user.role !== 'Admin' && venue.manager_id !== req.user.user_id) {
        return res.status(403).json({ success: false, message: 'Bạn chỉ được thêm sân vào cụm sân mình quản lý.' });
      }
      const code = String(court_code || `CRT-${Date.now().toString().slice(-6)}`).toUpperCase();
      const [result] = await mysqlPool.query(
        'INSERT INTO courts (venue_id, sport_id, court_code, name, base_price_per_hour, status) VALUES (?, ?, ?, ?, ?, ?)',
        [targetVenueId, sport.sport_id, code, finalName, finalPrice, finalStatus]
      );
      return res.status(201).json({
        success: true,
        message: 'Tạo sân thành công.',
        data: await getCourtDetailed(result.insertId)
      });
    }

    const venue = VENUES.find((v) => v.venue_id === targetVenueId && !v.deleted_at);
    if (!venue) return res.status(404).json({ success: false, message: 'Không tìm thấy cụm sân.' });
    if (req.user.role !== 'Admin' && venue.manager_id !== req.user.user_id) {
      return res.status(403).json({ success: false, message: 'Bạn chỉ được thêm sân vào cụm sân mình quản lý.' });
    }

    const newCourt = {
      court_id: nextIds.court++,
      venue_id: targetVenueId,
      sport_id: sport.sport_id,
      court_code: String(court_code || `CRT-${String(nextIds.court - 1).padStart(3, '0')}`).toUpperCase(),
      name: finalName,
      base_price_per_hour: finalPrice,
      status: finalStatus,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null
    };

    COURTS.push(newCourt);
    res.status(201).json({
      success: true,
      message: 'Tạo sân thành công.',
      data: await getCourtDetailed(newCourt.court_id)
    });
  } catch (err) {
    next(err);
  }
}

app.post('/api/courts', requireAuth, requireRole('Staff', 'Admin'), handleCreateCourt);
app.post('/api/owner/courts', requireAuth, requireRole('Staff', 'Admin'), handleCreateCourt);

async function handleUpdateCourt(req, res, next) {
  try {
    const courtId = Number(req.params.courtId);
    const existing = await getCourtDetailed(courtId);
    if (!existing) return res.status(404).json({ success: false, message: 'Không tìm thấy sân.' });
    if (req.user.role !== 'Admin' && existing.manager_id !== req.user.user_id) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền sửa sân này.' });
    }

    const updatedName = req.body.name || req.body.court_name || existing.name;
    const updatedPrice =
      req.body.base_price_per_hour !== undefined
        ? Number(req.body.base_price_per_hour)
        : req.body.price_per_hour !== undefined
        ? Number(req.body.price_per_hour)
        : existing.base_price_per_hour;
    const updatedStatus = normalizeCourtStatus(req.body.status || req.body.court_status || existing.status) || existing.status;

    if (mysqlPool) {
      await mysqlPool.query('UPDATE courts SET name = ?, base_price_per_hour = ?, status = ? WHERE court_id = ?', [
        String(updatedName).trim(),
        updatedPrice,
        updatedStatus,
        courtId
      ]);
      return res.json({ success: true, message: 'Cập nhật sân thành công.', data: await getCourtDetailed(courtId) });
    }

    const court = COURTS.find((c) => c.court_id === courtId);
    court.name = String(updatedName).trim();
    court.base_price_per_hour = updatedPrice;
    court.status = updatedStatus;
    court.updated_at = new Date().toISOString();

    res.json({ success: true, message: 'Cập nhật sân thành công.', data: await getCourtDetailed(courtId) });
  } catch (err) {
    next(err);
  }
}

app.put('/api/courts/:courtId', requireAuth, requireRole('Staff', 'Admin'), handleUpdateCourt);
app.put('/api/owner/courts/:courtId', requireAuth, requireRole('Staff', 'Admin'), handleUpdateCourt);
app.patch('/api/courts/:courtId/status', requireAuth, requireRole('Staff', 'Admin'), handleUpdateCourt);
app.patch('/api/owner/courts/:courtId/status', requireAuth, requireRole('Staff', 'Admin'), handleUpdateCourt);

app.post('/api/bookings', requireAuth, async (req, res, next) => {
  const {
    court_id,
    date,
    start_at,
    end_at,
    start_time,
    end_time,
    discount_amount = 0,
    deposit_required = 0,
    hold_minutes = 10,
    auto_pay = false,
    payment_method = 'Bank_Transfer'
  } = req.body;

  const rawStart = start_at || start_time;
  const rawEnd = end_at || end_time;

  if (!court_id || !rawStart || !rawEnd) {
    return res.status(400).json({
      success: false,
      message: 'Vui lòng truyền đầy đủ court_id và start_at/end_at (hoặc date, start_time, end_time).'
    });
  }

  const parsedStart = parseDateTime(String(rawStart).includes('T') || String(rawStart).includes(' ') ? rawStart : null, date, rawStart);
  const parsedEnd = parseDateTime(String(rawEnd).includes('T') || String(rawEnd).includes(' ') ? rawEnd : null, date, rawEnd);

  if (!parsedStart || !parsedEnd) {
    return res.status(400).json({ success: false, message: 'Định dạng thời gian không hợp lệ.' });
  }

  const durationMinutes = (parsedEnd.dateObj.getTime() - parsedStart.dateObj.getTime()) / (1000 * 60);
  if (durationMinutes < 30 || durationMinutes > 720) {
    return res.status(400).json({
      success: false,
      message: 'Thời lượng đặt sân phải từ 30 đến 720 phút và end_at > start_at (chk_bookings_time_range).'
    });
  }

  const court = await getCourtDetailed(court_id);
  if (!court) return res.status(404).json({ success: false, message: 'Sân không tồn tại.' });
  if (court.status !== 'Available' || !court.venue_is_active) {
    return res.status(400).json({ success: false, message: 'Sân hoặc cụm sân hiện đang bảo trì / ngưng hoạt động.' });
  }

  const startTimePart = parsedStart.sqlString.slice(11, 19);
  const endTimePart = parsedEnd.sqlString.slice(11, 19);
  if (
    !court.is_overnight &&
    (timeToMinutes(startTimePart) < timeToMinutes(court.open_time) || timeToMinutes(endTimePart) > timeToMinutes(court.close_time))
  ) {
    return res.status(400).json({
      success: false,
      message: `OUTSIDE_OPERATING_HOURS: Sân chỉ hoạt động trong khung giờ ${court.open_time} - ${court.close_time}.`
    });
  }

  if (courtLocks.has(court.court_id)) {
    return res.status(409).json({ success: false, message: 'Hệ thống đang xử lý giao dịch khác trên sân này.' });
  }

  courtLocks.add(court.court_id);
  try {
    const durationHours = Number((durationMinutes / 60).toFixed(2));
    const rentalAmount = Math.round(durationHours * court.base_price_per_hour);
    const discountAmt = Math.min(Number(discount_amount) || 0, rentalAmount);
    const depositReq = Math.min(Number(deposit_required) || 0, rentalAmount);
    const bookingCode = `BK-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    const clampedHold = Math.min(Math.max(Number(hold_minutes) || 10, 1), 30);
    const holdExpiresIso = new Date(Date.now() + 7 * 3600 * 1000 + clampedHold * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');

    if (mysqlPool) {
      const createdBooking = await withTransaction(req.user.user_id, async (conn) => {
        await conn.query('CALL sp_lock_court_days(?, ?, ?)', [court.court_id, parsedStart.sqlString, parsedEnd.sqlString]);

        const [resInsert] = await conn.query(
          `INSERT INTO bookings (booking_code, venue_id, court_id, customer_id, start_at, end_at,
                                 court_rental_amount, discount_amount, deposit_required, status, hold_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', DATE_ADD(fn_now_vn(), INTERVAL ? MINUTE))`,
          [
            bookingCode,
            court.venue_id,
            court.court_id,
            req.user.user_id,
            parsedStart.sqlString,
            parsedEnd.sqlString,
            rentalAmount,
            discountAmt,
            depositReq,
            clampedHold
          ]
        );

        const bookingId = resInsert.insertId;

        if (auto_pay) {
          const payAmount = rentalAmount - discountAmt;
          if (payAmount > 0) {
            await conn.query(
              `INSERT INTO payments (booking_id, processed_by, payment_type, payment_method, amount, transaction_ref, payment_status, paid_at)
               VALUES (?, ?, 'Full_Payment', ?, ?, ?, 'Success', fn_now_vn())`,
              [bookingId, req.user.user_id, payment_method, payAmount, `TX-${bookingCode}`]
            );
          }
          await conn.query("UPDATE bookings SET status = 'Fully_Paid' WHERE booking_id = ?", [bookingId]);
        }

        const [[row]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        return row;
      });

      return res.status(201).json({
        success: true,
        message: 'Tạo đơn đặt sân thành công.',
        data: { ...createdBooking, start_time: createdBooking.start_at, end_time: createdBooking.end_at }
      });
    }

    const conflicts = await findConflicts(court.court_id, parsedStart.sqlString, parsedEnd.sqlString);
    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'OVERBOOKING_CONFLICT: Khung giờ đã có người đặt trên sân này.',
        conflict_booking: conflicts[0]
      });
    }

    const newBooking = {
      booking_id: nextIds.booking++,
      booking_code: bookingCode,
      series_id: null,
      venue_id: court.venue_id,
      court_id: court.court_id,
      customer_id: req.user.user_id,
      checked_in_by: null,
      booking_date: parsedStart.sqlString.slice(0, 10),
      start_at: parsedStart.sqlString,
      end_at: parsedEnd.sqlString,
      start_time: parsedStart.sqlString,
      end_time: parsedEnd.sqlString,
      duration_hours: durationHours,
      court_rental_amount: rentalAmount,
      addons_amount: 0,
      discount_amount: discountAmt,
      total_amount: rentalAmount - discountAmt,
      deposit_required: depositReq,
      paid_amount: 0,
      refunded_amount: 0,
      remaining_amount: rentalAmount - discountAmt,
      overpaid_amount: 0,
      status: 'Pending',
      hold_expires_at: holdExpiresIso,
      is_active_slot: 1,
      cancel_reason: null,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    BOOKINGS.push(newBooking);
    writeMemoryAudit(newBooking.booking_id, 'CREATED', null, 'Pending', null, { ...newBooking }, req.user.user_id);

    if (auto_pay) {
      const payAmount = rentalAmount - discountAmt;
      if (payAmount > 0) {
        PAYMENTS.push({
          payment_id: nextIds.payment++,
          booking_id: newBooking.booking_id,
          processed_by: req.user.user_id,
          payment_type: 'Full_Payment',
          payment_method,
          amount: payAmount,
          transaction_ref: `TX-${bookingCode}`,
          payment_status: 'Success',
          paid_at: nowVnSql(),
          created_at: new Date().toISOString()
        });
      }
      recomputeMemoryBookingTotals(newBooking);
      newBooking.status = 'Fully_Paid';
      newBooking.hold_expires_at = null;
      newBooking.version += 1;
      writeMemoryAudit(newBooking.booking_id, 'STATUS_CHANGED', 'Pending', 'Fully_Paid', null, { ...newBooking }, req.user.user_id);
    }

    res.status(201).json({
      success: true,
      message: 'Tạo đơn đặt sân thành công.',
      data: newBooking
    });
  } catch (err) {
    if (err.sqlState === '45000') {
      return res.status(409).json({ success: false, message: err.message });
    }
    next(err);
  } finally {
    courtLocks.delete(court.court_id);
  }
});

app.post('/api/bookings/:bookingId/payments', requireAuth, async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const {
      payment_type = 'Full_Payment',
      payment_method = 'Bank_Transfer',
      amount,
      transaction_ref,
      auto_update_booking_status = true
    } = req.body;

    if (mysqlPool) {
      const result = await withTransaction(req.user.user_id, async (conn) => {
        const [[booking]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ? FOR UPDATE', [bookingId]);
        if (!booking) {
          const e = new Error('Không tìm thấy đơn đặt sân.');
          e.statusCode = 404;
          throw e;
        }

        const payAmt = amount !== undefined ? Number(amount) : Number(booking.remaining_amount);
        const txRef = String(transaction_ref || `TX-${bookingId}-${Date.now()}`).trim();
        const processedBy = payment_method === 'Cash' || req.user.role !== 'Customer' ? req.user.user_id : null;

        await conn.query(
          `INSERT INTO payments (booking_id, processed_by, payment_type, payment_method, amount, transaction_ref, payment_status, paid_at)
           VALUES (?, ?, ?, ?, ?, ?, 'Success', fn_now_vn())`,
          [bookingId, processedBy, payment_type, payment_method, payAmt, txRef]
        );

        const [[synced]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);

        if (auto_update_booking_status && payment_type !== 'Refund' && ['Pending', 'Deposit_Paid'].includes(synced.status)) {
          await conn.query('CALL sp_lock_court_days(?, ?, ?)', [synced.court_id, synced.start_at, synced.end_at]);
          const netPaid = Number(synced.paid_amount) - Number(synced.refunded_amount);
          const totalReq = Number(synced.total_amount);
          if (netPaid >= totalReq) {
            await conn.query("UPDATE bookings SET status = 'Fully_Paid' WHERE booking_id = ?", [bookingId]);
          } else if (netPaid >= Number(synced.deposit_required) && synced.status === 'Pending') {
            await conn.query("UPDATE bookings SET status = 'Deposit_Paid' WHERE booking_id = ?", [bookingId]);
          }
        }

        const [[finalBooking]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        return finalBooking;
      });

      return res.status(201).json({
        success: true,
        message: 'Ghi nhận thanh toán và đồng bộ trạng thái đơn thành công.',
        data: result
      });
    }

    const booking = BOOKINGS.find((b) => b.booking_id === bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn đặt sân.' });

    const payAmt = amount !== undefined ? Number(amount) : Number(booking.remaining_amount);
    if (!payAmt || payAmt <= 0) {
      return res.status(400).json({ success: false, message: 'Số tiền giao dịch (amount) phải lớn hơn 0.' });
    }

    if (payment_type === 'Refund' && !['Cancelled', 'Expired'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: 'REFUND_NOT_ALLOWED: Chỉ được hoàn tiền cho đơn đã Cancelled hoặc Expired.'
      });
    }

    const txRef = String(transaction_ref || `TX-${bookingId}-${Date.now()}`).trim();
    const newPayment = {
      payment_id: nextIds.payment++,
      booking_id: bookingId,
      processed_by: req.user.user_id,
      payment_type,
      payment_method,
      amount: payAmt,
      transaction_ref: txRef,
      payment_status: 'Success',
      paid_at: nowVnSql(),
      created_at: new Date().toISOString()
    };

    PAYMENTS.push(newPayment);
    recomputeMemoryBookingTotals(booking);

    if (auto_update_booking_status && payment_type !== 'Refund' && ['Pending', 'Deposit_Paid'].includes(booking.status)) {
      const netPaid = booking.paid_amount - booking.refunded_amount;
      const oldSt = booking.status;
      if (netPaid >= booking.total_amount) {
        booking.status = 'Fully_Paid';
        booking.hold_expires_at = null;
      } else if (netPaid >= booking.deposit_required && booking.status === 'Pending') {
        booking.status = 'Deposit_Paid';
        booking.hold_expires_at = null;
      }
      if (booking.status !== oldSt) {
        booking.version += 1;
        writeMemoryAudit(bookingId, 'STATUS_CHANGED', oldSt, booking.status, null, { ...booking }, req.user.user_id);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Ghi nhận thanh toán và đồng bộ trạng thái đơn thành công.',
      data: booking
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    if (err.sqlState === '45000') return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
});

app.get('/api/bookings/my', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.query;
    if (mysqlPool) {
      let sql = `
        SELECT b.*, c.name AS court_name, v.name AS venue_name, v.district
        FROM bookings b
        JOIN courts c ON b.court_id = c.court_id
        JOIN venues v ON b.venue_id = v.venue_id
        WHERE b.customer_id = ?
      `;
      const params = [req.user.user_id];
      if (status) {
        sql += ' AND b.status = ?';
        params.push(status);
      }
      sql += ' ORDER BY b.start_at DESC';
      const [rows] = await mysqlPool.query(sql, params);
      return res.json({ success: true, count: rows.length, data: rows });
    }

    let list = BOOKINGS.filter((b) => b.customer_id === req.user.user_id);
    if (status) list = list.filter((b) => b.status.toLowerCase() === String(status).toLowerCase());
    res.json({ success: true, count: list.length, data: list });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/bookings/:bookingId/cancel', requireAuth, async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const cancelReason = String(req.body.cancel_reason || req.body.reason || 'Khách hàng yêu cầu hủy lịch').trim();

    if (!cancelReason) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng cung cấp lý do hủy (cancel_reason không được để trống theo chk_bookings_cancel_reason).'
      });
    }

    if (mysqlPool) {
      const updated = await withTransaction(req.user.user_id, async (conn) => {
        const [[booking]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ? FOR UPDATE', [bookingId]);
        if (!booking) {
          const e = new Error('Không tìm thấy đơn đặt sân.');
          e.statusCode = 404;
          throw e;
        }
        if (booking.customer_id !== req.user.user_id && req.user.role === 'Customer') {
          const e = new Error('Bạn chỉ được hủy đơn của chính mình.');
          e.statusCode = 403;
          throw e;
        }
        await conn.query("UPDATE bookings SET status = 'Cancelled', cancel_reason = ? WHERE booking_id = ?", [
          cancelReason,
          bookingId
        ]);
        const [[row]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        return row;
      });
      return res.json({ success: true, message: 'Hủy đơn đặt sân thành công.', data: updated });
    }

    const booking = BOOKINGS.find((b) => b.booking_id === bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn đặt sân.' });
    if (booking.customer_id !== req.user.user_id && req.user.role === 'Customer') {
      return res.status(403).json({ success: false, message: 'Bạn chỉ được hủy đơn của chính mình.' });
    }
    if (!['Pending', 'Deposit_Paid', 'Fully_Paid'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: `INVALID_STATE_TRANSITION: Không thể hủy đơn đang ở trạng thái ${booking.status}.`
      });
    }

    const oldSt = booking.status;
    booking.status = 'Cancelled';
    booking.cancel_reason = cancelReason;
    booking.is_active_slot = 0;
    booking.version += 1;
    writeMemoryAudit(bookingId, 'STATUS_CHANGED', oldSt, 'Cancelled', null, { ...booking }, req.user.user_id);

    res.json({ success: true, message: 'Hủy đơn đặt sân thành công.', data: booking });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    if (err.sqlState === '45000') return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
});

app.patch('/api/bookings/:bookingId/reschedule', requireAuth, async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const { court_id, date, start_at, end_at, start_time, end_time } = req.body;
    const rawStart = start_at || start_time;
    const rawEnd = end_at || end_time;

    const parsedStart = parseDateTime(String(rawStart || '').includes('T') || String(rawStart || '').includes(' ') ? rawStart : null, date, rawStart);
    const parsedEnd = parseDateTime(String(rawEnd || '').includes('T') || String(rawEnd || '').includes(' ') ? rawEnd : null, date, rawEnd);

    if (!parsedStart || !parsedEnd || parsedStart.dateObj >= parsedEnd.dateObj) {
      return res.status(400).json({ success: false, message: 'Khung giờ đổi lịch không hợp lệ.' });
    }

    if (mysqlPool) {
      const updated = await withTransaction(req.user.user_id, async (conn) => {
        const [[booking]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ? FOR UPDATE', [bookingId]);
        if (!booking) {
          const e = new Error('Không tìm thấy đơn đặt sân.');
          e.statusCode = 404;
          throw e;
        }
        const targetCourtId = court_id ? Number(court_id) : booking.court_id;
        await conn.query('CALL sp_lock_court_days(?, ?, ?)', [targetCourtId, parsedStart.sqlString, parsedEnd.sqlString]);
        const nextStatus = ['Cancelled', 'Expired'].includes(booking.status) ? 'Pending' : booking.status;
        await conn.query('UPDATE bookings SET court_id = ?, start_at = ?, end_at = ?, status = ? WHERE booking_id = ?', [
          targetCourtId,
          parsedStart.sqlString,
          parsedEnd.sqlString,
          nextStatus,
          bookingId
        ]);
        const [[row]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        return row;
      });
      return res.json({ success: true, message: 'Đổi khung giờ đặt sân thành công.', data: updated });
    }

    const booking = BOOKINGS.find((b) => b.booking_id === bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn đặt sân.' });
    if (booking.status === 'Completed') {
      return res.status(400).json({ success: false, message: 'COMPLETED_IMMUTABLE: Không thể sửa đơn đã hoàn thành.' });
    }

    const targetCourtId = court_id ? Number(court_id) : booking.court_id;
    const conflicts = await findConflicts(targetCourtId, parsedStart.sqlString, parsedEnd.sqlString, bookingId);
    if (conflicts.length > 0) {
      return res.status(409).json({ success: false, message: 'Khung giờ mới bị trùng với đơn khác.' });
    }

    booking.court_id = targetCourtId;
    booking.start_at = parsedStart.sqlString;
    booking.end_at = parsedEnd.sqlString;
    booking.start_time = parsedStart.sqlString;
    booking.end_time = parsedEnd.sqlString;
    if (['Cancelled', 'Expired'].includes(booking.status)) {
      booking.status = 'Pending';
      booking.hold_expires_at = new Date(Date.now() + 7 * 3600 * 1000 + 10 * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      booking.is_active_slot = 1;
    }
    booking.version += 1;
    writeMemoryAudit(bookingId, 'RESCHEDULED', booking.status, booking.status, null, { ...booking }, req.user.user_id);

    res.json({ success: true, message: 'Đổi khung giờ đặt sân thành công.', data: booking });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    if (err.sqlState === '45000') return res.status(409).json({ success: false, message: err.message });
    next(err);
  }
});

app.get('/api/owner/bookings', requireAuth, requireRole('Staff', 'Admin'), async (req, res, next) => {
  try {
    const { status, court_id, venue_id } = req.query;
    if (mysqlPool) {
      let sql = `
        SELECT b.*, u.full_name AS customer_name, u.phone AS customer_phone, c.name AS court_name, v.name AS venue_name
        FROM bookings b
        JOIN courts c ON b.court_id = c.court_id
        JOIN venues v ON b.venue_id = v.venue_id
        JOIN users u ON b.customer_id = u.user_id
        WHERE 1=1
      `;
      const params = [];
      if (req.user.role !== 'Admin') {
        sql += ' AND v.manager_id = ?';
        params.push(req.user.user_id);
      }
      if (status) {
        sql += ' AND b.status = ?';
        params.push(status);
      }
      if (court_id) {
        sql += ' AND b.court_id = ?';
        params.push(Number(court_id));
      }
      if (venue_id) {
        sql += ' AND b.venue_id = ?';
        params.push(Number(venue_id));
      }
      const [rows] = await mysqlPool.query(sql, params);
      return res.json({ success: true, count: rows.length, data: rows });
    }

    const list = [];
    for (const b of BOOKINGS) {
      const court = await getCourtDetailed(b.court_id);
      if (req.user.role === 'Admin' || (court && court.manager_id === req.user.user_id)) {
        if (status && b.status.toLowerCase() !== String(status).toLowerCase()) continue;
        if (court_id && b.court_id !== Number(court_id)) continue;
        if (venue_id && b.venue_id !== Number(venue_id)) continue;
        list.push({ ...b, court_name: court ? court.name : null, venue_name: court ? court.venue_name : null });
      }
    }
    res.json({ success: true, count: list.length, data: list });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/owner/bookings/:bookingId/process', requireAuth, requireRole('Staff', 'Admin'), async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const { action, reason, cancel_reason, payment_method = 'Bank_Transfer' } = req.body;
    const normalizedAction = String(action || '').toUpperCase();

    if (!['APPROVE', 'COMPLETE', 'REJECT', 'CANCEL'].includes(normalizedAction)) {
      return res.status(400).json({
        success: false,
        message: 'action chỉ nhận APPROVE (Xác nhận/Thu đủ tiền), COMPLETE (Hoàn thành), REJECT hoặc CANCEL.'
      });
    }

    if (mysqlPool) {
      const updated = await withTransaction(req.user.user_id, async (conn) => {
        const [[booking]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ? FOR UPDATE', [bookingId]);
        if (!booking) {
          const e = new Error('Không tìm thấy đơn đặt sân.');
          e.statusCode = 404;
          throw e;
        }
        const court = await getCourtDetailed(booking.court_id, conn);
        if (req.user.role !== 'Admin' && (!court || court.manager_id !== req.user.user_id)) {
          const e = new Error('Bạn không có quyền xử lý đơn của cụm sân khác.');
          e.statusCode = 403;
          throw e;
        }

        if (normalizedAction === 'APPROVE') {
          await conn.query('CALL sp_lock_court_days(?, ?, ?)', [booking.court_id, booking.start_at, booking.end_at]);
          const remaining = Number(booking.remaining_amount);
          if (remaining > 0) {
            await conn.query(
              `INSERT INTO payments (booking_id, processed_by, payment_type, payment_method, amount, transaction_ref, payment_status, paid_at)
               VALUES (?, ?, 'Full_Payment', ?, ?, ?, 'Success', fn_now_vn())`,
              [bookingId, req.user.user_id, payment_method, remaining, `TX-APP-${bookingId}-${Date.now()}`]
            );
          }
          await conn.query("UPDATE bookings SET status = 'Fully_Paid' WHERE booking_id = ?", [bookingId]);
        } else if (normalizedAction === 'COMPLETE') {
          await conn.query("UPDATE bookings SET status = 'Completed', checked_in_by = ? WHERE booking_id = ?", [
            req.user.user_id,
            bookingId
          ]);
        } else {
          const finalReason = String(cancel_reason || reason || 'Chủ sân từ chối / hủy lịch').trim();
          await conn.query("UPDATE bookings SET status = 'Cancelled', cancel_reason = ? WHERE booking_id = ?", [
            finalReason,
            bookingId
          ]);
        }

        const [[row]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        return row;
      });

      return res.json({ success: true, message: 'Xử lý đơn đặt sân thành công.', data: updated });
    }

    const booking = BOOKINGS.find((b) => b.booking_id === bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn đặt sân.' });
    const court = await getCourtDetailed(booking.court_id);
    if (req.user.role !== 'Admin' && (!court || court.manager_id !== req.user.user_id)) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền xử lý đơn của cụm sân khác.' });
    }

    const oldSt = booking.status;
    if (normalizedAction === 'APPROVE') {
      if (booking.remaining_amount > 0) {
        PAYMENTS.push({
          payment_id: nextIds.payment++,
          booking_id: bookingId,
          processed_by: req.user.user_id,
          payment_type: 'Full_Payment',
          payment_method,
          amount: booking.remaining_amount,
          transaction_ref: `TX-APP-${bookingId}-${Date.now()}`,
          payment_status: 'Success',
          paid_at: nowVnSql(),
          created_at: new Date().toISOString()
        });
        recomputeMemoryBookingTotals(booking);
      }
      booking.status = 'Fully_Paid';
      booking.hold_expires_at = null;
      booking.is_active_slot = 1;
    } else if (normalizedAction === 'COMPLETE') {
      booking.status = 'Completed';
      booking.checked_in_by = req.user.user_id;
      booking.hold_expires_at = null;
    } else {
      booking.status = 'Cancelled';
      booking.cancel_reason = String(cancel_reason || reason || 'Chủ sân từ chối / hủy lịch').trim();
      booking.is_active_slot = 0;
    }

    booking.version += 1;
    writeMemoryAudit(bookingId, 'STATUS_CHANGED', oldSt, booking.status, null, { ...booking }, req.user.user_id);

    res.json({ success: true, message: 'Xử lý đơn đặt sân thành công.', data: booking });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    if (err.sqlState === '45000') return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
});

app.post('/api/venues/:venueId/services', requireAuth, requireRole('Staff', 'Admin'), async (req, res, next) => {
  try {
    const venueId = Number(req.params.venueId);
    const { service_code, name, unit = 'Phần', unit_price } = req.body;
    if (!name || unit_price === undefined || Number(unit_price) < 0) {
      return res.status(400).json({ success: false, message: 'Vui lòng cung cấp name và unit_price >= 0.' });
    }

    const code = String(service_code || `SRV-${Date.now().toString().slice(-5)}`).toUpperCase();

    if (mysqlPool) {
      const [result] = await mysqlPool.query(
        'INSERT INTO services (venue_id, service_code, name, unit, unit_price, is_active) VALUES (?, ?, ?, ?, ?, 1)',
        [venueId, code, String(name).trim(), String(unit).trim(), Number(unit_price)]
      );
      const [[row]] = await mysqlPool.query('SELECT * FROM services WHERE service_id = ?', [result.insertId]);
      return res.status(201).json({ success: true, data: row });
    }

    const srv = {
      service_id: nextIds.service++,
      venue_id: venueId,
      service_code: code,
      name: String(name).trim(),
      unit: String(unit).trim(),
      unit_price: Number(unit_price),
      is_active: 1,
      deleted_at: null
    };
    SERVICES.push(srv);
    res.status(201).json({ success: true, data: srv });
  } catch (err) {
    next(err);
  }
});

app.post('/api/bookings/:bookingId/addons', requireAuth, async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const { service_id, quantity = 1 } = req.body;
    if (!service_id || Number(quantity) <= 0) {
      return res.status(400).json({ success: false, message: 'Vui lòng truyền service_id và quantity > 0.' });
    }

    if (mysqlPool) {
      const updated = await withTransaction(req.user.user_id, async (conn) => {
        const [[booking]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ? FOR UPDATE', [bookingId]);
        if (!booking) {
          const e = new Error('Không tìm thấy đơn đặt sân.');
          e.statusCode = 404;
          throw e;
        }
        const [[srv]] = await conn.query(
          'SELECT * FROM services WHERE service_id = ? AND venue_id = ? AND is_active = 1 AND deleted_at IS NULL',
          [Number(service_id), booking.venue_id]
        );
        if (!srv) {
          const e = new Error('Dịch vụ không tồn tại hoặc không thuộc cụm sân này.');
          e.statusCode = 404;
          throw e;
        }
        await conn.query(
          `INSERT INTO booking_addons (venue_id, booking_id, service_id, quantity, unit_price)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
          [booking.venue_id, bookingId, srv.service_id, Number(quantity), srv.unit_price]
        );
        const [[row]] = await conn.query('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        return row;
      });
      return res.status(201).json({ success: true, message: 'Thêm dịch vụ đi kèm thành công.', data: updated });
    }

    const booking = BOOKINGS.find((b) => b.booking_id === bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn đặt sân.' });
    if (!['Pending', 'Deposit_Paid', 'Fully_Paid'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: 'ADDON_NOT_ALLOWED: Chỉ được thêm dịch vụ cho đơn Pending, Deposit_Paid hoặc Fully_Paid.'
      });
    }

    const srv = SERVICES.find((s) => s.service_id === Number(service_id) && s.venue_id === booking.venue_id && s.is_active && !s.deleted_at);
    if (!srv) return res.status(404).json({ success: false, message: 'Dịch vụ không tồn tại.' });

    const existingAddon = BOOKING_ADDONS.find((a) => a.booking_id === bookingId && a.service_id === srv.service_id);
    if (existingAddon) {
      existingAddon.quantity += Number(quantity);
      existingAddon.line_total = existingAddon.quantity * existingAddon.unit_price;
    } else {
      BOOKING_ADDONS.push({
        addon_id: nextIds.addon++,
        venue_id: booking.venue_id,
        booking_id: bookingId,
        service_id: srv.service_id,
        quantity: Number(quantity),
        unit_price: srv.unit_price,
        line_total: Number(quantity) * srv.unit_price
      });
    }

    recomputeMemoryBookingTotals(booking);
    writeMemoryAudit(bookingId, 'ADDON_CHANGED', null, null, null, { service_id: srv.service_id, quantity }, req.user.user_id);

    res.status(201).json({ success: true, message: 'Thêm dịch vụ đi kèm thành công.', data: booking });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    if (err.sqlState === '45000') return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
});

app.get('/api/bookings/:bookingId/audit-logs', requireAuth, async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId);
    if (mysqlPool) {
      const [rows] = await mysqlPool.query('SELECT * FROM booking_audit_logs WHERE booking_id = ? ORDER BY created_at ASC', [bookingId]);
      return res.json({ success: true, count: rows.length, data: rows });
    }
    const list = BOOKING_AUDIT_LOGS.filter((a) => a.booking_id === bookingId);
    res.json({ success: true, count: list.length, data: list });
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/users', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    if (mysqlPool) {
      const [rows] = await mysqlPool.query(
        'SELECT user_id, full_name, email, phone, phone_norm, role, status, created_at FROM users WHERE deleted_at IS NULL'
      );
      return res.json({ success: true, count: rows.length, data: rows });
    }
    res.json({ success: true, count: USERS.filter((u) => !u.deleted_at).length, data: USERS.filter((u) => !u.deleted_at) });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/admin/users/:userId/status', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const targetUserId = Number(req.params.userId);
    const finalStatus = normalizeUserStatus(req.body.status || req.body.account_status);
    if (!finalStatus) {
      return res.status(400).json({ success: false, message: 'status chỉ nhận Active, Locked hoặc Inactive.' });
    }

    if (mysqlPool) {
      await mysqlPool.query('UPDATE users SET status = ? WHERE user_id = ?', [finalStatus, targetUserId]);
      return res.json({ success: true, data: await getUserById(targetUserId) });
    }

    const user = USERS.find((u) => u.user_id === targetUserId && !u.deleted_at);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản.' });
    user.status = finalStatus;
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Không tìm thấy endpoint: ${req.method} ${req.originalUrl}`
  });
});

app.use((err, req, res, next) => {
  res.status(500).json({
    success: false,
    message: 'Lỗi hệ thống nội bộ.',
    error: err.message
  });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  initDatabase().then(() => {
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  });
}

module.exports = app;