-- Nen tang: MySQL 8.0.16+ / InnoDB / utf8mb4
-- Pham vi: tim kiem san, xem chi tiet, lich hoat dong, dat san, duyet/huy,
-- quan ly san, bao tri, quan ly tai khoan va duyet tai khoan chu san.
--
-- Cai dat: chay tren database moi. Script DROP cac bang/procedure cung ten.
-- Backend: xac thuc JWT/session truoc khi goi procedure; khong tin user_id tu body.
-- Cac procedure co transaction rieng: goi rieng, khong boc them transaction ben ngoai.
-- Moi connection nen SET time_zone = '+07:00'.

CREATE DATABASE IF NOT EXISTS dat_san_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE dat_san_db;

SET NAMES utf8mb4;
SET time_zone = '+07:00';

DROP PROCEDURE IF EXISTS sp_create_booking;
DROP PROCEDURE IF EXISTS sp_process_booking;
DROP PROCEDURE IF EXISTS sp_cancel_booking;
DROP PROCEDURE IF EXISTS sp_review_owner_account;
DROP PROCEDURE IF EXISTS sp_add_court_maintenance;
DROP PROCEDURE IF EXISTS sp_set_court_status;

DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS booking_status_history;
DROP TABLE IF EXISTS BOOKINGS;
DROP TABLE IF EXISTS court_maintenance_periods;
DROP TABLE IF EXISTS court_images;
DROP TABLE IF EXISTS COURTS;
DROP TABLE IF EXISTS facility_operating_hours;
DROP TABLE IF EXISTS SPORTS;
DROP TABLE IF EXISTS FACILITIES;
DROP TABLE IF EXISTS owner_verifications;
DROP TABLE IF EXISTS USERS;

-- 1. Tai khoan va phan quyen co ban
CREATE TABLE USERS (
  user_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(120) NOT NULL,
  username VARCHAR(50) NOT NULL,
  email VARCHAR(150) DEFAULT NULL,
  phone VARCHAR(20) DEFAULT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('USER','OWNER','ADMIN') NOT NULL DEFAULT 'USER',
  status ENUM('Active','Locked') NOT NULL DEFAULT 'Active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role_status (role,status),
  CONSTRAINT chk_users_full_name CHECK (TRIM(full_name) <> ''),
  CONSTRAINT chk_users_username CHECK (TRIM(username) <> '')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- UC09: moi user co the gui yeu cau tro thanh OWNER; Admin duyet.
CREATE TABLE owner_verifications (
  user_id BIGINT UNSIGNED NOT NULL,
  verification_status ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
  document_url VARCHAR(500) DEFAULT NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by BIGINT UNSIGNED DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  reject_reason VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (user_id),
  KEY idx_owner_verification_queue (verification_status,submitted_at),
  CONSTRAINT fk_owner_verification_user FOREIGN KEY (user_id)
    REFERENCES USERS(user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_owner_verification_reviewer FOREIGN KEY (reviewed_by)
    REFERENCES USERS(user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_owner_verification_review CHECK (
    (verification_status='Pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR
    (verification_status IN ('Approved','Rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT chk_owner_verification_reason CHECK (
    verification_status <> 'Rejected'
    OR (reject_reason IS NOT NULL AND TRIM(reject_reason) <> '')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Cum san va lich hoat dong theo thu trong tuan
CREATE TABLE FACILITIES (
  facility_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id BIGINT UNSIGNED NOT NULL,
  facility_name VARCHAR(150) NOT NULL,
  description TEXT DEFAULT NULL,
  address VARCHAR(255) NOT NULL,
  district VARCHAR(100) NOT NULL,
  city VARCHAR(100) NOT NULL DEFAULT 'Hà Nội',
  hotline VARCHAR(20) DEFAULT NULL,
  cancellation_cutoff_hours SMALLINT UNSIGNED NOT NULL DEFAULT 24,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (facility_id),
  KEY idx_facility_search (city,district,is_active),
  KEY idx_facility_owner (owner_id,is_active),
  CONSTRAINT fk_facility_owner FOREIGN KEY (owner_id)
    REFERENCES USERS(user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_facility_name CHECK (TRIM(facility_name) <> ''),
  CONSTRAINT chk_facility_cutoff CHECK (cancellation_cutoff_hours <= 720)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ISO day: 1=Monday ... 7=Sunday. Moi facility nen co du 7 dong lich.
CREATE TABLE facility_operating_hours (
  facility_id BIGINT UNSIGNED NOT NULL,
  day_of_week TINYINT UNSIGNED NOT NULL,
  open_time TIME NOT NULL,
  close_time TIME NOT NULL,
  is_closed TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (facility_id,day_of_week),
  CONSTRAINT fk_facility_hours_facility FOREIGN KEY (facility_id)
    REFERENCES FACILITIES(facility_id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT chk_facility_hours_day CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT chk_facility_hours_range CHECK (is_closed=1 OR close_time>open_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Danh muc mon the thao de frontend loc theo mon va tranh nhap lieu khong thong nhat.
CREATE TABLE SPORTS (
  sport_id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sport_name VARCHAR(80) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (sport_id),
  UNIQUE KEY uq_sports_name (sport_name),
  CONSTRAINT chk_sports_name CHECK (TRIM(sport_name) <> '')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Du lieu danh muc mau; co the them/bat/tat mon the thao qua trang Admin.
INSERT INTO SPORTS(sport_name) VALUES
  ('Cầu lông'),('Bóng đá'),('Bóng rổ'),('Tennis'),('Bóng chuyền'),('Bóng bàn');

-- 3. San con, anh san va gia co dinh theo gio
CREATE TABLE COURTS (
  court_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  facility_id BIGINT UNSIGNED NOT NULL,
  sport_id SMALLINT UNSIGNED NOT NULL,
  court_code VARCHAR(40) NOT NULL,
  court_name VARCHAR(120) NOT NULL,
  description TEXT DEFAULT NULL,
  cover_image_url VARCHAR(500) DEFAULT NULL,
  price_per_hour DECIMAL(12,2) NOT NULL,
  min_booking_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  max_booking_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 360,
  requires_approval TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('Available','Inactive') NOT NULL DEFAULT 'Available',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (court_id),
  UNIQUE KEY uq_court_facility_code (facility_id,court_code),
  KEY idx_court_search (sport_id,status,price_per_hour),
  KEY idx_court_facility (facility_id,status),
  CONSTRAINT fk_court_facility FOREIGN KEY (facility_id)
    REFERENCES FACILITIES(facility_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_court_sport FOREIGN KEY (sport_id)
    REFERENCES SPORTS(sport_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_court_price CHECK (price_per_hour >= 0),
  CONSTRAINT chk_court_duration CHECK (
    min_booking_minutes >= 15
    AND max_booking_minutes >= min_booking_minutes
    AND max_booking_minutes <= 720
  ),
  CONSTRAINT chk_court_name CHECK (TRIM(court_name) <> '')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Anh thu vien cua san: COURTS.cover_image_url la anh dai dien,
-- court_images luu cac anh bo sung cho gallery tren trang chi tiet.
-- Chi luu URL/duong dan file (local storage, object storage hoac CDN), khong luu binary trong DB.
CREATE TABLE court_images (
  image_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  court_id BIGINT UNSIGNED NOT NULL,
  image_url VARCHAR(500) NOT NULL,
  alt_text VARCHAR(255) DEFAULT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (image_id),
  KEY idx_court_images_gallery (court_id,sort_order,image_id),
  CONSTRAINT fk_court_images_court FOREIGN KEY (court_id)
    REFERENCES COURTS(court_id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT chk_court_images_url CHECK (TRIM(image_url) <> '')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lich bao tri theo khoang thoi gian; khong phai tat ca ngay deu dong cua.
CREATE TABLE court_maintenance_periods (
  maintenance_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  court_id BIGINT UNSIGNED NOT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  reason VARCHAR(255) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (maintenance_id),
  KEY idx_maintenance_court_time (court_id,start_time,end_time),
  CONSTRAINT fk_maintenance_court FOREIGN KEY (court_id)
    REFERENCES COURTS(court_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_maintenance_creator FOREIGN KEY (created_by)
    REFERENCES USERS(user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_maintenance_range CHECK (end_time>start_time),
  CONSTRAINT chk_maintenance_reason CHECK (TRIM(reason)<>'')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Don dat san
CREATE TABLE BOOKINGS (
  booking_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  court_id BIGINT UNSIGNED NOT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  duration_minutes SMALLINT UNSIGNED GENERATED ALWAYS AS
    (TIMESTAMPDIFF(MINUTE,start_time,end_time)) STORED,
  unit_price_snapshot DECIMAL(12,2) NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL,
  status ENUM('Pending','Confirmed','Cancelled','Rejected') NOT NULL,
  processed_by BIGINT UNSIGNED DEFAULT NULL,
  processed_at DATETIME DEFAULT NULL,
  decision_note VARCHAR(255) DEFAULT NULL,
  cancelled_by BIGINT UNSIGNED DEFAULT NULL,
  cancelled_at DATETIME DEFAULT NULL,
  cancel_reason VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (booking_id),
  KEY idx_booking_conflict (court_id,status,start_time,end_time),
  KEY idx_booking_user_history (user_id,start_time),
  KEY idx_booking_owner_queue (court_id,status,created_at),
  KEY idx_booking_processor (processed_by),
  KEY idx_booking_canceller (cancelled_by),
  CONSTRAINT fk_booking_user FOREIGN KEY (user_id)
    REFERENCES USERS(user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_booking_court FOREIGN KEY (court_id)
    REFERENCES COURTS(court_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_booking_processor FOREIGN KEY (processed_by)
    REFERENCES USERS(user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_booking_canceller FOREIGN KEY (cancelled_by)
    REFERENCES USERS(user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_booking_time CHECK (
    end_time>start_time AND DATE(start_time)=DATE(end_time)
    AND SECOND(start_time)=0 AND SECOND(end_time)=0
  ),
  CONSTRAINT chk_booking_amount CHECK (unit_price_snapshot>=0 AND total_amount>=0),
  CONSTRAINT chk_booking_cancel_meta CHECK (
    status<>'Cancelled'
    OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
        AND cancel_reason IS NOT NULL AND TRIM(cancel_reason)<>'')
  ),
  CONSTRAINT chk_booking_reject_meta CHECK (
    status<>'Rejected'
    OR (processed_by IS NOT NULL AND processed_at IS NOT NULL
        AND decision_note IS NOT NULL AND TRIM(decision_note)<>'')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lich su trang thai de trang "Theo doi don" hien thi duoc cac lan thay doi.
CREATE TABLE booking_status_history (
  history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id BIGINT UNSIGNED NOT NULL,
  old_status VARCHAR(20) DEFAULT NULL,
  new_status VARCHAR(20) NOT NULL,
  changed_by BIGINT UNSIGNED DEFAULT NULL,
  note VARCHAR(255) DEFAULT NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (history_id),
  KEY idx_booking_history (booking_id,changed_at),
  CONSTRAINT fk_booking_history_booking FOREIGN KEY (booking_id)
    REFERENCES BOOKINGS(booking_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_booking_history_actor FOREIGN KEY (changed_by)
    REFERENCES USERS(user_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Thong bao trong ung dung; email/SMS co the bo sung sau neu that su can.
CREATE TABLE notifications (
  notification_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  booking_id BIGINT UNSIGNED DEFAULT NULL,
  notification_type ENUM(
    'BOOKING_CREATED','BOOKING_PENDING_APPROVAL','BOOKING_CONFIRMED',
    'BOOKING_REJECTED','BOOKING_CANCELLED','OWNER_VERIFICATION_RESULT'
  ) NOT NULL,
  title VARCHAR(150) NOT NULL,
  message VARCHAR(500) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at DATETIME DEFAULT NULL,
  PRIMARY KEY (notification_id),
  KEY idx_notifications_user (user_id,read_at,created_at),
  KEY idx_notifications_booking (booking_id),
  CONSTRAINT fk_notification_user FOREIGN KEY (user_id)
    REFERENCES USERS(user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_notification_booking FOREIGN KEY (booking_id)
    REFERENCES BOOKINGS(booking_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- Tao don: kiem tra quyen, gio hoat dong, bao tri, thoi luong va trung lich.
-- Pending cung chiem slot cho den khi owner chap nhan/tu choi hoac user huy.
CREATE PROCEDURE sp_create_booking(
  IN p_user_id BIGINT UNSIGNED,
  IN p_court_id BIGINT UNSIGNED,
  IN p_start DATETIME,
  IN p_end DATETIME
)
BEGIN
  DECLARE v_user_count INT DEFAULT 0;
  DECLARE v_court_count INT DEFAULT 0;
  DECLARE v_hours_count INT DEFAULT 0;
  DECLARE v_conflict_booking_id BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_maintenance_conflict_id BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_requires_approval TINYINT;
  DECLARE v_court_status VARCHAR(20);
  DECLARE v_facility_active TINYINT;
  DECLARE v_owner_id BIGINT UNSIGNED;
  DECLARE v_price DECIMAL(12,2);
  DECLARE v_min SMALLINT UNSIGNED;
  DECLARE v_max SMALLINT UNSIGNED;
  DECLARE v_open TIME;
  DECLARE v_close TIME;
  DECLARE v_closed TINYINT;
  DECLARE v_open_at DATETIME;
  DECLARE v_close_at DATETIME;
  DECLARE v_day TINYINT UNSIGNED;
  DECLARE v_duration INT;
  DECLARE v_total DECIMAL(12,2);
  DECLARE v_status VARCHAR(20);
  DECLARE v_booking_id BIGINT UNSIGNED;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  IF p_start IS NULL OR p_end IS NULL OR p_start>=p_end
     OR SECOND(p_start)<>0 OR SECOND(p_end)<>0
     OR DATE(p_start)<>DATE(p_end) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khoang thoi gian khong hop le';
  END IF;
  IF p_start<CURRENT_TIMESTAMP THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khong the dat san trong qua khu';
  END IF;

  START TRANSACTION;

  SELECT COUNT(*) INTO v_user_count
  FROM USERS WHERE user_id=p_user_id AND status='Active';
  IF v_user_count=0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Tai khoan khong ton tai hoac dang bi khoa';
  END IF;

  SELECT COUNT(*) INTO v_court_count
  FROM COURTS C JOIN FACILITIES F ON F.facility_id=C.facility_id
  WHERE C.court_id=p_court_id;
  IF v_court_count=0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khong tim thay san';
  END IF;

  -- Khoa dong COURT: hai yeu cau dong thoi cung san se duoc xu ly lan luot.
  SELECT C.requires_approval,C.status,F.is_active,F.owner_id,
         C.price_per_hour,C.min_booking_minutes,C.max_booking_minutes
    INTO v_requires_approval,v_court_status,v_facility_active,v_owner_id,
         v_price,v_min,v_max
  FROM COURTS C JOIN FACILITIES F ON F.facility_id=C.facility_id
  WHERE C.court_id=p_court_id
  FOR UPDATE;

  IF v_court_status<>'Available' OR v_facility_active<>1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='San hoac cum san dang ngung phuc vu';
  END IF;

  SET v_duration=TIMESTAMPDIFF(MINUTE,p_start,p_end);
  IF v_duration<v_min OR v_duration>v_max THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Thoi luong dat vuot gioi han cua san';
  END IF;

  SET v_day=WEEKDAY(DATE(p_start))+1;
  SELECT COUNT(*) INTO v_hours_count
  FROM facility_operating_hours
  WHERE facility_id=(SELECT facility_id FROM COURTS WHERE court_id=p_court_id)
    AND day_of_week=v_day;
  IF v_hours_count=0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Chua cau hinh gio hoat dong cua cum san';
  END IF;

  SELECT open_time,close_time,is_closed
    INTO v_open,v_close,v_closed
  FROM facility_operating_hours
  WHERE facility_id=(SELECT facility_id FROM COURTS WHERE court_id=p_court_id)
    AND day_of_week=v_day;

  IF v_closed=1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Cum san dong cua vao ngay da chon';
  END IF;

  SET v_open_at=TIMESTAMP(DATE(p_start),v_open);
  SET v_close_at=TIMESTAMP(DATE(p_start),v_close);
  IF p_start<v_open_at OR p_end>v_close_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khung gio nam ngoai gio hoat dong';
  END IF;

  SELECT maintenance_id INTO v_maintenance_conflict_id
  FROM court_maintenance_periods
  WHERE court_id=p_court_id AND start_time<p_end AND end_time>p_start
  LIMIT 1 FOR UPDATE;
  IF v_maintenance_conflict_id IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='San dang trong thoi gian bao tri';
  END IF;

  SELECT booking_id INTO v_conflict_booking_id
  FROM BOOKINGS
  WHERE court_id=p_court_id
    AND status IN ('Pending','Confirmed')
    AND p_start<end_time AND p_end>start_time
  LIMIT 1 FOR UPDATE;
  IF v_conflict_booking_id IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khung gio da co nguoi dat';
  END IF;

  SET v_total=ROUND(v_price*v_duration/60,2);
  SET v_status=IF(v_requires_approval=1,'Pending','Confirmed');

  INSERT INTO BOOKINGS
    (user_id,court_id,start_time,end_time,unit_price_snapshot,total_amount,status)
  VALUES
    (p_user_id,p_court_id,p_start,p_end,v_price,v_total,v_status);

  SET v_booking_id=LAST_INSERT_ID();

  INSERT INTO booking_status_history
    (booking_id,old_status,new_status,changed_by,note)
  VALUES (v_booking_id,NULL,v_status,p_user_id,'Tao yeu cau dat san');

  IF v_status='Pending' THEN
    INSERT INTO notifications(user_id,booking_id,notification_type,title,message)
    VALUES
      (p_user_id,v_booking_id,'BOOKING_CREATED','Da tiep nhan yeu cau',
       'Yeu cau dat san dang cho chu san xac nhan'),
      (v_owner_id,v_booking_id,'BOOKING_PENDING_APPROVAL','Co yeu cau dat san moi',
       'Vui long kiem tra va xu ly yeu cau dat san');
  ELSE
    INSERT INTO notifications(user_id,booking_id,notification_type,title,message)
    VALUES (p_user_id,v_booking_id,'BOOKING_CONFIRMED','Dat san thanh cong',
            'Khung gio da duoc xac nhan');
  END IF;

  COMMIT;
  SELECT v_booking_id AS booking_id,v_status AS booking_status,
         v_duration AS duration_minutes,v_total AS total_amount;
END$$

-- Chu san xu ly yeu cau Pending. Pending da giu slot tu luc tao don.
CREATE PROCEDURE sp_process_booking(
  IN p_booking_id BIGINT UNSIGNED,
  IN p_owner_id BIGINT UNSIGNED,
  IN p_accept TINYINT,
  IN p_note VARCHAR(255)
)
BEGIN
  DECLARE v_user_id BIGINT UNSIGNED;
  DECLARE v_facility_owner BIGINT UNSIGNED;
  DECLARE v_status VARCHAR(20);
  DECLARE v_role VARCHAR(20);
  DECLARE v_user_status VARCHAR(20);
  DECLARE v_owner_verified INT DEFAULT 0;
  DECLARE v_new_status VARCHAR(20);

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  SELECT B.user_id,B.status,F.owner_id
    INTO v_user_id,v_status,v_facility_owner
  FROM BOOKINGS B
  JOIN COURTS C ON C.court_id=B.court_id
  JOIN FACILITIES F ON F.facility_id=C.facility_id
  WHERE B.booking_id=p_booking_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khong tim thay booking';
  END IF;

  SELECT role,status INTO v_role,v_user_status
  FROM USERS WHERE user_id=p_owner_id FOR UPDATE;

  SELECT COUNT(*) INTO v_owner_verified
  FROM owner_verifications
  WHERE user_id=p_owner_id AND verification_status='Approved';

  IF v_facility_owner<>p_owner_id
     OR v_role IS NULL OR v_user_status IS NULL
     OR v_role<>'OWNER' OR v_user_status<>'Active'
     OR v_owner_verified=0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khong co quyen xu ly booking nay';
  END IF;

  IF v_status<>'Pending' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Booking khong con o trang thai cho duyet';
  END IF;
  IF p_accept IS NULL OR p_accept NOT IN (0,1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Lua chon xu ly khong hop le';
  END IF;
  IF p_accept=0 AND (p_note IS NULL OR TRIM(p_note)='') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Can nhap ly do tu choi';
  END IF;

  SET v_new_status=IF(p_accept=1,'Confirmed','Rejected');
  UPDATE BOOKINGS
  SET status=v_new_status,processed_by=p_owner_id,
      processed_at=CURRENT_TIMESTAMP,decision_note=p_note
  WHERE booking_id=p_booking_id;

  INSERT INTO booking_status_history
    (booking_id,old_status,new_status,changed_by,note)
  VALUES (p_booking_id,'Pending',v_new_status,p_owner_id,p_note);

  INSERT INTO notifications(user_id,booking_id,notification_type,title,message)
  VALUES
    (v_user_id,p_booking_id,
     IF(p_accept=1,'BOOKING_CONFIRMED','BOOKING_REJECTED'),
     IF(p_accept=1,'Yeu cau da duoc xac nhan','Yeu cau dat san bi tu choi'),
     COALESCE(p_note,IF(p_accept=1,'Chu san da xac nhan booking','')));

  COMMIT;
END$$

-- Nguoi dat huy don theo chinh sach gioi han huy cua cum san.
CREATE PROCEDURE sp_cancel_booking(
  IN p_booking_id BIGINT UNSIGNED,
  IN p_user_id BIGINT UNSIGNED,
  IN p_reason VARCHAR(255)
)
BEGIN
  DECLARE v_booking_user BIGINT UNSIGNED;
  DECLARE v_court BIGINT UNSIGNED;
  DECLARE v_owner BIGINT UNSIGNED;
  DECLARE v_start DATETIME;
  DECLARE v_status VARCHAR(20);
  DECLARE v_cutoff SMALLINT UNSIGNED;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  SELECT B.user_id,B.court_id,B.start_time,B.status,
         F.owner_id,F.cancellation_cutoff_hours
    INTO v_booking_user,v_court,v_start,v_status,v_owner,v_cutoff
  FROM BOOKINGS B
  JOIN COURTS C ON C.court_id=B.court_id
  JOIN FACILITIES F ON F.facility_id=C.facility_id
  WHERE B.booking_id=p_booking_id
  FOR UPDATE;

  IF v_booking_user IS NULL OR v_booking_user<>p_user_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khong tim thay booking hoac khong co quyen';
  END IF;
  IF v_status NOT IN ('Pending','Confirmed') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Booking khong the huy o trang thai hien tai';
  END IF;
  IF p_reason IS NULL OR TRIM(p_reason)='' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Can nhap ly do huy';
  END IF;
  IF v_start<=DATE_ADD(CURRENT_TIMESTAMP,INTERVAL v_cutoff HOUR) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Da qua thoi han cho phep huy';
  END IF;

  UPDATE BOOKINGS
  SET status='Cancelled',cancelled_by=p_user_id,
      cancelled_at=CURRENT_TIMESTAMP,cancel_reason=p_reason
  WHERE booking_id=p_booking_id;

  INSERT INTO booking_status_history
    (booking_id,old_status,new_status,changed_by,note)
  VALUES (p_booking_id,v_status,'Cancelled',p_user_id,p_reason);

  INSERT INTO notifications(user_id,booking_id,notification_type,title,message)
  VALUES
    (p_user_id,p_booking_id,'BOOKING_CANCELLED','Da huy yeu cau dat san',p_reason),
    (v_owner,p_booking_id,'BOOKING_CANCELLED','Nguoi choi da huy san',p_reason);

  COMMIT;
END$$

-- Admin duyet/tuchoi yeu cau tro thanh chu san.
CREATE PROCEDURE sp_review_owner_account(
  IN p_admin_id BIGINT UNSIGNED,
  IN p_user_id BIGINT UNSIGNED,
  IN p_approve TINYINT,
  IN p_reason VARCHAR(255)
)
BEGIN
  DECLARE v_admin_role VARCHAR(20);
  DECLARE v_admin_status VARCHAR(20);
  DECLARE v_verification_status VARCHAR(20);

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  SELECT role,status INTO v_admin_role,v_admin_status
  FROM USERS WHERE user_id=p_admin_id FOR UPDATE;

  IF v_admin_role IS NULL OR v_admin_status IS NULL
     OR v_admin_role<>'ADMIN' OR v_admin_status<>'Active' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Chi Admin dang hoat dong moi duoc duyet';
  END IF;

  SELECT verification_status INTO v_verification_status
  FROM owner_verifications WHERE user_id=p_user_id FOR UPDATE;

  IF v_verification_status IS NULL OR v_verification_status<>'Pending' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khong co yeu cau cho duyet';
  END IF;
  IF p_approve IS NULL OR p_approve NOT IN (0,1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Lua chon duyet khong hop le';
  END IF;
  IF p_approve=0 AND (p_reason IS NULL OR TRIM(p_reason)='') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Can nhap ly do tu choi';
  END IF;

  UPDATE owner_verifications
  SET verification_status=IF(p_approve=1,'Approved','Rejected'),
      reviewed_by=p_admin_id,reviewed_at=CURRENT_TIMESTAMP,
      reject_reason=IF(p_approve=1,NULL,p_reason)
  WHERE user_id=p_user_id;

  IF p_approve=1 THEN
    UPDATE USERS SET role='OWNER' WHERE user_id=p_user_id;
  END IF;

  INSERT INTO notifications(user_id,notification_type,title,message)
  VALUES
    (p_user_id,'OWNER_VERIFICATION_RESULT',
     IF(p_approve=1,'Tai khoan chu san da duoc duyet','Yeu cau chu san bi tu choi'),
     IF(p_approve=1,'Ban co the bat dau quan ly cum san',p_reason));

  COMMIT;
END$$

-- Them khoang bao tri. Khong cho tao bao tri trung booking dang con hieu luc.
CREATE PROCEDURE sp_add_court_maintenance(
  IN p_actor_id BIGINT UNSIGNED,
  IN p_court_id BIGINT UNSIGNED,
  IN p_start DATETIME,
  IN p_end DATETIME,
  IN p_reason VARCHAR(255)
)
BEGIN
  DECLARE v_owner BIGINT UNSIGNED;
  DECLARE v_role VARCHAR(20);
  DECLARE v_user_status VARCHAR(20);
  DECLARE v_overlap_booking_id BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_actor_verified INT DEFAULT 0;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  IF p_start IS NULL OR p_end IS NULL OR p_end<=p_start
     OR p_reason IS NULL OR TRIM(p_reason)='' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Thong tin bao tri khong hop le';
  END IF;

  START TRANSACTION;

  SELECT F.owner_id INTO v_owner
  FROM COURTS C JOIN FACILITIES F ON F.facility_id=C.facility_id
  WHERE C.court_id=p_court_id
  FOR UPDATE;

  IF v_owner IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khong tim thay san';
  END IF;

  SELECT role,status INTO v_role,v_user_status
  FROM USERS WHERE user_id=p_actor_id FOR UPDATE;

  SELECT COUNT(*) INTO v_actor_verified
  FROM owner_verifications
  WHERE user_id=p_actor_id AND verification_status='Approved';

  IF v_user_status IS NULL OR v_role IS NULL OR v_user_status<>'Active'
     OR NOT (v_role='ADMIN' OR (v_role='OWNER' AND v_owner=p_actor_id AND v_actor_verified=1)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khong co quyen quan ly san nay';
  END IF;

  SELECT booking_id INTO v_overlap_booking_id
  FROM BOOKINGS
  WHERE court_id=p_court_id
    AND status IN ('Pending','Confirmed')
    AND start_time<p_end AND end_time>p_start
  LIMIT 1 FOR UPDATE;
  IF v_overlap_booking_id IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Co booking dang hieu luc trong khoang bao tri; can xu ly booking truoc';
  END IF;

  INSERT INTO court_maintenance_periods(court_id,start_time,end_time,reason,created_by)
  VALUES(p_court_id,p_start,p_end,p_reason,p_actor_id);

  COMMIT;
END$$

-- Dong/mo nhan dat cho toan bo san. Khong dong san khi con booking tuong lai hieu luc.
CREATE PROCEDURE sp_set_court_status(
  IN p_actor_id BIGINT UNSIGNED,
  IN p_court_id BIGINT UNSIGNED,
  IN p_new_status VARCHAR(20)
)
BEGIN
  DECLARE v_owner BIGINT UNSIGNED;
  DECLARE v_role VARCHAR(20);
  DECLARE v_user_status VARCHAR(20);
  DECLARE v_verified INT DEFAULT 0;
  DECLARE v_active_booking_id BIGINT UNSIGNED DEFAULT NULL;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  IF p_new_status IS NULL OR p_new_status NOT IN ('Available','Inactive') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Trang thai san khong hop le';
  END IF;

  START TRANSACTION;

  SELECT F.owner_id INTO v_owner
  FROM COURTS C JOIN FACILITIES F ON F.facility_id=C.facility_id
  WHERE C.court_id=p_court_id
  FOR UPDATE;

  IF v_owner IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khong tim thay san';
  END IF;

  SELECT role,status INTO v_role,v_user_status
  FROM USERS WHERE user_id=p_actor_id FOR UPDATE;

  SELECT COUNT(*) INTO v_verified
  FROM owner_verifications
  WHERE user_id=p_actor_id AND verification_status='Approved';

  IF v_user_status IS NULL OR v_role IS NULL OR v_user_status<>'Active'
     OR NOT (v_role='ADMIN' OR (v_role='OWNER' AND v_owner=p_actor_id AND v_verified=1)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Khong co quyen quan ly san nay';
  END IF;

  IF p_new_status='Inactive' THEN
    SELECT booking_id INTO v_active_booking_id
    FROM BOOKINGS
    WHERE court_id=p_court_id
      AND status IN ('Pending','Confirmed')
      AND end_time>CURRENT_TIMESTAMP
    LIMIT 1 FOR UPDATE;
    IF v_active_booking_id IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Can xu ly cac booking con hieu luc truoc khi dong san';
    END IF;
  END IF;

  UPDATE COURTS SET status=p_new_status WHERE court_id=p_court_id;
  COMMIT;
END$$

DELIMITER ;

-- Ghi chu tich hop:
-- 1. Tim san: loc COURTS + SPORTS + FACILITIES theo mon, quan/huyen, gia va trang thai.
-- 2. Anh san: cover_image_url la anh dai dien; court_images la gallery, sap xep theo sort_order.
-- 3. Lich trong: loai booking Pending/Confirmed va maintenance periods co khoang giao nhau.
-- 4. Chi hien san neu facility is_active=1, court status='Available', sport is_active=1.
-- 5. Moi facility can du 7 dong facility_operating_hours truoc khi mo dat san.
-- 6. Tao booking bang sp_create_booking; khong tu INSERT BOOKINGS tu frontend.
-- 7. Pending chiem slot de tranh hai khach cung yeu cau mot khoang gio.
-- 8. Xac nhan/tu choi bang sp_process_booking; huy bang sp_cancel_booking.
-- 9. UC07 dung sp_add_court_maintenance hoac sp_set_court_status.
-- 10. UC09 dung sp_review_owner_account. Tai khoan OWNER chi hop le sau khi Approved.
-- 11. Quan ly gallery qua court_images; backend phai kiem tra quyen so huu san.
-- 12. Cac CRUD con lai phai kiem tra role va owner_id tai backend.
-- 13. Khi sua gio hoat dong, backend khoa dong FACILITIES tuong ung (FOR UPDATE),
--     kiem tra khong lam vo booking Pending/Confirmed, roi moi cap nhat lich.
-- 14. Khi sua gia/trang thai cua COURTS, cap nhat trong transaction; row lock tren COURTS
--     se dong bo voi sp_create_booking/sp_add_court_maintenance/sp_set_court_status.
--
-- Co y khong dua vao phien ban nay: thanh toan/hoan tien, khuyen mai, dich vu phu,
-- dat lap, gia theo gio/ngay le, SMS/email, Staff role va audit tai chinh nang cao.
