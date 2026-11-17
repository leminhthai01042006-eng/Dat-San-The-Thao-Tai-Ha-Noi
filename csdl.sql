-- =====================================================================================
-- COURTPULSE DB v3 (MySQL 8.0.16+) - Schema cài mới
-- =====================================================================================
--
-- * Chỉ dùng cho CÀI MỚI, không DROP bảng; CREATE TABLE sẽ lỗi nếu bảng đã tồn tại.
--   DB đang chạy cần migration ALTER riêng, KHÔNG chạy file này lên production hiện có.
-- * Mục 9 (function/procedure/trigger) dùng DROP ... IF EXISTS nên chạy lại được nhiều lần.
-- * Chạy: mysql --default-character-set=utf8mb4 < schema_v3_clean.sql
--
-- GIAO THỨC BẮT BUỘC PHÍA ỨNG DỤNG:
--   1. Mỗi kết nối: SET time_zone = '+07:00'; SET @app_user_id = <user_id>;
--      (mọi cột DATETIME nghiệp vụ là GIỜ VN; @app_user_id được ghi vào audit)
--   2. Mỗi transaction đặt sân / thanh toán / dịch vụ:
--      SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;  (tránh gap lock)
--   3. Retry transaction khi gặp lỗi 1213 (deadlock) hoặc 1205 (lock wait timeout).
--   4. Khóa dòng booking TRƯỚC khi chạm payments/booking_addons; trước khi đổi giờ/sân/khôi phục đơn
--      hoặc chuyển Pending -> đã thanh toán, gọi CALL sp_lock_court_days(court_id, start_time, end_time).
--      Cũng khóa theo sân/ngày trước khi xác nhận đơn chờ duyệt.
--   5. KHÔNG ghi tay paid_amount / refunded_amount / addons_amount (trigger tự đồng bộ từ
--      payments, booking_addons). Refund là dòng payments riêng (payment_type='Refund', 'Success'),
--      chỉ cho đơn Cancelled/Expired.
--   6. Job dọn đơn hết hạn dùng fn_now_vn() thay NOW().
--
-- CHUYỂN TRẠNG THÁI BOOKING (trigger chặn mọi cặp khác):
--   Pending      -> Deposit_Paid | Fully_Paid | Cancelled | Expired (chỉ khi đã quá hold_expires_at)
--   Deposit_Paid -> Fully_Paid | Completed | Cancelled
--   Fully_Paid   -> Completed | Cancelled
--   Cancelled / Expired -> Pending (khôi phục, được cấp hạn giữ chỗ mới)
--   Completed    -> (không chuyển đi đâu; chỉ khi đã đến giờ và thanh toán đủ)
--   approval_status theo dõi xác nhận riêng: sân thường tự Confirmed; sân cần duyệt bắt đầu Pending.
--   Quản lý cụm sân hiện tại (@app_user_id) có thể xác nhận hoặc từ chối đơn còn hạn.
--   Khi từ chối, cập nhật approval_status = 'Rejected' và status = 'Cancelled' trong cùng câu UPDATE.

SET NAMES utf8mb4;
SET time_zone = '+07:00';
SET sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

CREATE DATABASE IF NOT EXISTS `sports_court_booking`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `sports_court_booking`;

-- DEV ONLY (không bật trên production): DROP DATABASE `sports_court_booking`;

-- =====================================================================================
-- 1. BẢNG USERS
-- Xóa mềm qua deleted_at; SĐT được trigger chuẩn hóa (0xxx = +84xxx), phone_norm là khóa UNIQUE.
-- =====================================================================================
CREATE TABLE `USERS` (
  `user_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `full_name` VARCHAR(120) NOT NULL,
  `email` VARCHAR(150) NOT NULL,
  `phone` VARCHAR(20) NOT NULL,
  `password_hash` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `role` ENUM('USER', 'OWNER', 'ADMIN', 'Staff') NOT NULL DEFAULT 'USER',
  `status` ENUM('Active', 'Locked', 'Inactive') NOT NULL DEFAULT 'Active',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` TIMESTAMP NULL DEFAULT NULL,
  `active_flag` TINYINT GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, 1, NULL)) VIRTUAL,
  `phone_norm` VARCHAR(20) GENERATED ALWAYS AS (
    CASE WHEN LEFT(`phone`, 3) = '+84' THEN CONCAT('0', SUBSTRING(`phone`, 4)) ELSE `phone` END
  ) VIRTUAL,
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_users_email_active` (`email`, `active_flag`),
  UNIQUE KEY `uq_users_phone_active` (`phone_norm`, `active_flag`),
  KEY `idx_users_role_status` (`role`, `status`, `deleted_at`),
  CONSTRAINT `chk_users_full_name` CHECK (TRIM(`full_name`) <> ''),
  CONSTRAINT `chk_users_phone_vn` CHECK (REGEXP_LIKE(`phone`, '^(0|\\+84)(3|5|7|8|9)[0-9]{8}$'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================================
-- 2. BẢNG VENUES
-- Giờ mở/đóng cửa có CHECK; manager được trigger kiểm tra (mục 9).
-- =====================================================================================
CREATE TABLE `FACILITIES` (
  `facility_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `venue_code` VARCHAR(30) NOT NULL,
  `facility_name` VARCHAR(150) NOT NULL,
  `address` VARCHAR(255) NOT NULL,
  `district` VARCHAR(100) NOT NULL,
  `city` VARCHAR(100) NOT NULL,
  `timezone` VARCHAR(50) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh' COMMENT 'Hiện chỉ hỗ trợ Asia/Ho_Chi_Minh (xem CHECK)',
  `hotline` VARCHAR(20) NOT NULL,
  `open_time` TIME NOT NULL DEFAULT '05:00:00' COMMENT 'Giờ mở cửa (giờ VN)',
  `close_time` TIME NOT NULL DEFAULT '23:30:00',
  `is_overnight` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 nếu đóng cửa qua 00:00 hôm sau',
  `owner_id` BIGINT UNSIGNED NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` TIMESTAMP NULL DEFAULT NULL,
  `active_flag` TINYINT GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, 1, NULL)) VIRTUAL,
  PRIMARY KEY (`facility_id`),
  UNIQUE KEY `uq_venues_code_active` (`venue_code`, `active_flag`),
  KEY `idx_venues_location` (`city`, `district`, `is_active`, `deleted_at`),
  KEY `idx_venues_manager` (`owner_id`),
  CONSTRAINT `fk_venues_manager` FOREIGN KEY (`owner_id`) REFERENCES `USERS` (`user_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_venues_hours` CHECK (
    (`is_overnight` = 0 AND `close_time` > `open_time`)
    OR (`is_overnight` = 1 AND `close_time` <= `open_time`)
  ),
  CONSTRAINT `chk_venues_timezone` CHECK (`timezone` = 'Asia/Ho_Chi_Minh')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================================
-- 3. BẢNG SPORTS, COURTS, COURT_DAY_LOCKS
-- =====================================================================================
CREATE TABLE `sports` (
  `sport_id` SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sport_code` VARCHAR(30) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `default_slot_minutes` SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`sport_id`),
  UNIQUE KEY `uq_sports_code` (`sport_code`),
  CONSTRAINT `chk_sports_slot` CHECK (`default_slot_minutes` IN (30, 45, 60, 90, 120))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `COURTS` (
  `court_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `facility_id` BIGINT UNSIGNED NOT NULL,
  `sport_type` VARCHAR(30) NOT NULL,
  `court_code` VARCHAR(40) NOT NULL,
  `court_name` VARCHAR(120) NOT NULL,
  `price_per_hour` DECIMAL(12, 2) NOT NULL,
  `requires_approval` BOOLEAN NOT NULL DEFAULT FALSE,
  `status` ENUM('Available', 'Maintenance', 'Inactive') NOT NULL DEFAULT 'Available',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` TIMESTAMP NULL DEFAULT NULL,
  `active_flag` TINYINT GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, 1, NULL)) VIRTUAL,
  PRIMARY KEY (`court_id`),
  UNIQUE KEY `uq_courts_venue_code_active` (`facility_id`, `court_code`, `active_flag`),
  UNIQUE KEY `uq_courts_venue_court` (`facility_id`, `court_id`),
  KEY `idx_courts_lookup` (`facility_id`, `sport_type`, `status`, `deleted_at`),
  CONSTRAINT `fk_courts_venue` FOREIGN KEY (`facility_id`) REFERENCES `FACILITIES` (`facility_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_courts_sport` FOREIGN KEY (`sport_type`) REFERENCES `sports` (`sport_code`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_courts_price` CHECK (`price_per_hour` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- court_day_locks: mutex theo (sân, ngày lịch), lấy qua sp_lock_court_days; cố ý không có FK tới courts.
CREATE TABLE `court_day_locks` (
  `court_id` BIGINT UNSIGNED NOT NULL,
  `booking_date` DATE NOT NULL COMMENT 'Ngày LỊCH (DATE của start_time / end_time), không phải ngày vận hành',
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`court_id`, `booking_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Bảng Mutex Lock hạt mịn theo (court_id, ngày lịch)';

-- =====================================================================================
-- 4. BẢNG PRICING_RULES
-- Trigger chặn 2 rule active cùng sân/ưu tiên/loại mà chồng chéo thứ, hiệu lực và khung giờ.
-- =====================================================================================
CREATE TABLE `pricing_rules` (
  `rule_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `court_id` BIGINT UNSIGNED NOT NULL,
  `rule_name` VARCHAR(120) NOT NULL,
  `days_of_week_mask` TINYINT UNSIGNED NOT NULL DEFAULT 127,
  `is_holiday_rule` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Rule ngày lễ: áp dụng cả tuần nên mask phải = 127',
  `start_time` TIME NOT NULL,
  `end_time` TIME NOT NULL COMMENT 'end_time <= start_time nghĩa là rule kéo qua 00:00 hôm sau (00:00:00 = nửa đêm)',
  `price_per_hour` DECIMAL(12, 2) NOT NULL,
  `priority` SMALLINT UNSIGNED NOT NULL DEFAULT 10 COMMENT 'Độ ưu tiên khi khớp nhiều rule; trigger chặn trùng ưu tiên khi chồng chéo',
  `valid_from` DATE DEFAULT NULL COMMENT 'Rule có hiệu lực từ ngày này (NULL = không giới hạn đầu)',
  `valid_to` DATE DEFAULT NULL COMMENT 'Rule có hiệu lực đến hết ngày này (NULL = không giới hạn cuối)',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`rule_id`),
  KEY `idx_pricing_lookup` (`court_id`, `is_active`, `is_holiday_rule`, `start_time`, `end_time`),
  KEY `idx_pricing_validity` (`court_id`, `is_active`, `valid_from`, `valid_to`),
  CONSTRAINT `fk_pricing_court` FOREIGN KEY (`court_id`) REFERENCES `COURTS` (`court_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_pricing_name` CHECK (TRIM(`rule_name`) <> ''),
  CONSTRAINT `chk_pricing_mask` CHECK (`days_of_week_mask` BETWEEN 1 AND 127),
  CONSTRAINT `chk_pricing_price` CHECK (`price_per_hour` >= 0),
  CONSTRAINT `chk_pricing_time` CHECK (`start_time` <> `end_time`),
  CONSTRAINT `chk_pricing_holiday_mask` CHECK (`is_holiday_rule` = 0 OR `days_of_week_mask` = 127),
  CONSTRAINT `chk_pricing_valid` CHECK (`valid_from` IS NULL OR `valid_to` IS NULL OR `valid_to` >= `valid_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================================
-- 5. BẢNG BOOKING_SERIES
-- FK kép từ bookings: booking thuộc chuỗi thì facility_id và user_id phải trùng với chuỗi.
-- =====================================================================================
CREATE TABLE `booking_series` (
  `series_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `facility_id` BIGINT UNSIGNED NOT NULL,
  `court_id` BIGINT UNSIGNED NOT NULL COMMENT 'Sân cố định của chuỗi (phải thuộc cùng facility_id)',
  `user_id` BIGINT UNSIGNED NOT NULL,
  `recurrence_pattern` VARCHAR(100) NOT NULL COMMENT 'DAILY hoặc WEEKLY:MON,TUE,... (VD: WEEKLY:TUE,THU)',
  `slot_start_time` TIME NOT NULL COMMENT 'Giờ bắt đầu mỗi buổi (giờ VN)',
  `slot_end_time` TIME NOT NULL COMMENT 'Giờ kết thúc mỗi buổi (giờ VN); <= slot_start_time nghĩa là qua 00:00',
  `series_start_date` DATE NOT NULL,
  `series_end_date` DATE NOT NULL,
  `total_sessions` SMALLINT UNSIGNED NOT NULL,
  `status` ENUM('Active', 'Completed', 'Cancelled') NOT NULL DEFAULT 'Active',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`series_id`),
  UNIQUE KEY `uq_series_venue_customer` (`series_id`, `facility_id`, `user_id`),
  KEY `idx_series_venue_court` (`facility_id`, `court_id`),
  KEY `idx_series_customer` (`user_id`, `status`),
  KEY `idx_series_venue_dates` (`facility_id`, `status`, `series_start_date`, `series_end_date`),
  CONSTRAINT `fk_series_venue` FOREIGN KEY (`facility_id`) REFERENCES `FACILITIES` (`facility_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_series_court` FOREIGN KEY (`facility_id`, `court_id`) REFERENCES `COURTS` (`facility_id`, `court_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_series_customer` FOREIGN KEY (`user_id`) REFERENCES `USERS` (`user_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_series_dates` CHECK (`series_end_date` >= `series_start_date`),
  CONSTRAINT `chk_series_span` CHECK (DATEDIFF(`series_end_date`, `series_start_date`) <= 366),
  CONSTRAINT `chk_series_sessions` CHECK (`total_sessions` BETWEEN 1 AND 366),
  CONSTRAINT `chk_series_slot` CHECK (`slot_start_time` <> `slot_end_time`),
  CONSTRAINT `chk_series_pattern` CHECK (
    REGEXP_LIKE(`recurrence_pattern`,
      '^(DAILY|WEEKLY:(MON|TUE|WED|THU|FRI|SAT|SUN)(,(MON|TUE|WED|THU|FRI|SAT|SUN))*)$')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================================
-- 6. BẢNG BOOKINGS
-- booking_date, addons_amount, paid_amount, refunded_amount do trigger tính, không ghi tay.
-- =====================================================================================
CREATE TABLE `BOOKINGS` (
  `booking_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `booking_code` VARCHAR(32) NOT NULL,
  `series_id` BIGINT UNSIGNED DEFAULT NULL COMMENT 'Liên kết chuỗi đặt sân cố định theo tháng',
  `facility_id` BIGINT UNSIGNED NOT NULL,
  `court_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `checked_in_by` BIGINT UNSIGNED DEFAULT NULL,
  `booking_date` DATE NOT NULL DEFAULT (CURRENT_DATE) COMMENT 'Ngày vận hành - do trigger tự tính, client gửi gì cũng bị ghi đè',
  `start_time` DATETIME NOT NULL COMMENT 'Thời điểm bắt đầu thực tế, GIỜ VN (Hỗ trợ xuyên đêm)',
  `end_time` DATETIME NOT NULL COMMENT 'Thời điểm kết thúc thực tế, GIỜ VN',
  `duration_hours` DECIMAL(5, 2) GENERATED ALWAYS AS (
    ROUND(TIMESTAMPDIFF(MINUTE, `start_time`, `end_time`) / 60.0, 2)
  ) STORED,
  `court_rental_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `addons_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00 COMMENT 'Tự đồng bộ từ booking_addons',
  `discount_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `total_amount` DECIMAL(12, 2) GENERATED ALWAYS AS (
    GREATEST(`court_rental_amount` + `addons_amount` - `discount_amount`, 0.00)
  ) STORED,
  `deposit_required` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `paid_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00 COMMENT 'Tự đồng bộ từ payments',
  `refunded_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00 COMMENT 'Tự đồng bộ từ payments',
  `remaining_amount` DECIMAL(12, 2) GENERATED ALWAYS AS (
    GREATEST((`court_rental_amount` + `addons_amount` - `discount_amount`) - (`paid_amount` - `refunded_amount`), 0.00)
  ) STORED,
  `overpaid_amount` DECIMAL(12, 2) GENERATED ALWAYS AS (
    GREATEST((`paid_amount` - `refunded_amount`) - (`court_rental_amount` + `addons_amount` - `discount_amount`), 0.00)
  ) STORED,
  `status` ENUM('Pending', 'Deposit_Paid', 'Fully_Paid', 'Completed', 'Cancelled', 'Expired') NOT NULL DEFAULT 'Pending',
  `approval_status` ENUM('Pending', 'Confirmed', 'Rejected') NOT NULL DEFAULT 'Confirmed',
  `hold_expires_at` DATETIME DEFAULT NULL COMMENT 'Hạn giữ chỗ (giờ VN): bắt buộc với Pending, tự NULL khi đã thanh toán/hoàn thành',
  `is_active_slot` TINYINT(1) GENERATED ALWAYS AS (
    CASE WHEN `status` IN ('Pending', 'Deposit_Paid', 'Fully_Paid', 'Completed') THEN 1 ELSE 0 END
  ) STORED,
  `cancel_reason` VARCHAR(255) DEFAULT NULL,
  `version` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Optimistic Locking version',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`booking_id`),
  UNIQUE KEY `uq_bookings_code` (`booking_code`),
  UNIQUE KEY `uq_bookings_venue_booking` (`facility_id`, `booking_id`),
  KEY `idx_bookings_conflict_check` (`court_id`, `is_active_slot`, `start_time`, `end_time`, `status`, `hold_expires_at`),
  KEY `idx_bookings_venue_schedule` (`facility_id`, `booking_date`, `is_active_slot`, `court_id`, `start_time`, `end_time`),
  KEY `idx_bookings_pending_timeout` (`status`, `hold_expires_at`),
  KEY `idx_bookings_customer` (`user_id`, `start_time` DESC),
  KEY `idx_bookings_series` (`series_id`, `facility_id`, `user_id`),
  KEY `idx_bookings_checked_in_by` (`checked_in_by`),
  CONSTRAINT `fk_bookings_venue_court`
    FOREIGN KEY (`facility_id`, `court_id`) REFERENCES `COURTS` (`facility_id`, `court_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_bookings_series`
    FOREIGN KEY (`series_id`, `facility_id`, `user_id`)
    REFERENCES `booking_series` (`series_id`, `facility_id`, `user_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_bookings_customer`
    FOREIGN KEY (`user_id`) REFERENCES `USERS` (`user_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_bookings_checked_in_by`
    FOREIGN KEY (`checked_in_by`) REFERENCES `USERS` (`user_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_bookings_time_range` CHECK (
    `end_time` > `start_time` AND TIMESTAMPDIFF(MINUTE, `start_time`, `end_time`) BETWEEN 30 AND 720
  ),
  CONSTRAINT `chk_bookings_amounts` CHECK (
    `court_rental_amount` >= 0 AND `addons_amount` >= 0 AND `discount_amount` >= 0 AND
    `deposit_required` >= 0 AND `paid_amount` >= 0 AND `refunded_amount` >= 0 AND
    `refunded_amount` <= `paid_amount`
  ),
  CONSTRAINT `chk_bookings_discount` CHECK (`discount_amount` <= `court_rental_amount` + `addons_amount`),
  CONSTRAINT `chk_bookings_pending_hold` CHECK (`status` <> 'Pending' OR `hold_expires_at` IS NOT NULL),
  CONSTRAINT `chk_bookings_hold_cleared` CHECK (
    `status` NOT IN ('Deposit_Paid', 'Fully_Paid', 'Completed') OR `hold_expires_at` IS NULL
  ),
  CONSTRAINT `chk_bookings_cancel_reason` CHECK (
    `status` <> 'Cancelled' OR (`cancel_reason` IS NOT NULL AND TRIM(`cancel_reason`) <> '')
  ),
  CONSTRAINT `chk_bookings_deposit` CHECK (`deposit_required` <= `court_rental_amount`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================================
-- 7. BẢNG SERVICES & BOOKING_ADDONS
-- =====================================================================================
CREATE TABLE `services` (
  `service_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `facility_id` BIGINT UNSIGNED NOT NULL,
  `service_code` VARCHAR(40) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `unit` VARCHAR(30) NOT NULL,
  `unit_price` DECIMAL(12, 2) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `deleted_at` TIMESTAMP NULL DEFAULT NULL,
  `active_flag` TINYINT GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, 1, NULL)) VIRTUAL,
  PRIMARY KEY (`service_id`),
  UNIQUE KEY `uq_services_venue_code_active` (`facility_id`, `service_code`, `active_flag`),
  UNIQUE KEY `uq_services_venue_service` (`facility_id`, `service_id`),
  CONSTRAINT `fk_services_venue` FOREIGN KEY (`facility_id`) REFERENCES `FACILITIES` (`facility_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_services_price` CHECK (`unit_price` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `booking_addons` (
  `addon_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `facility_id` BIGINT UNSIGNED NOT NULL,
  `booking_id` BIGINT UNSIGNED NOT NULL,
  `service_id` BIGINT UNSIGNED NOT NULL,
  `quantity` INT UNSIGNED NOT NULL DEFAULT 1,
  `unit_price` DECIMAL(12, 2) NOT NULL COMMENT 'Snapshot giá lúc thêm; phải bằng services.unit_price (trigger kiểm tra)',
  `line_total` DECIMAL(12, 2) GENERATED ALWAYS AS (`quantity` * `unit_price`) STORED,
  PRIMARY KEY (`addon_id`),
  UNIQUE KEY `uq_booking_service` (`booking_id`, `service_id`),
  CONSTRAINT `fk_addons_venue_booking`
    FOREIGN KEY (`facility_id`, `booking_id`) REFERENCES `BOOKINGS` (`facility_id`, `booking_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_addons_venue_service`
    FOREIGN KEY (`facility_id`, `service_id`) REFERENCES `services` (`facility_id`, `service_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_addons_qty_price` CHECK (`quantity` > 0 AND `unit_price` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================================
-- 8. BẢNG PAYMENTS & BOOKING_AUDIT_LOGS
-- payments là sổ cái chỉ thêm; audit chỉ INSERT (trigger chặn UPDATE/DELETE).
-- =====================================================================================
CREATE TABLE `payments` (
  `payment_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `booking_id` BIGINT UNSIGNED NOT NULL,
  `processed_by` BIGINT UNSIGNED DEFAULT NULL,
  `payment_type` ENUM('Deposit', 'Remaining_Balance', 'Full_Payment', 'Refund') NOT NULL,
  `payment_method` ENUM('Bank_Transfer', 'VNPay', 'MoMo', 'Cash', 'Credit_Card') NOT NULL,
  `amount` DECIMAL(12, 2) NOT NULL,
  `transaction_ref` VARCHAR(100) NOT NULL,
  `payment_status` ENUM('Pending', 'Success', 'Failed', 'Refunded') NOT NULL DEFAULT 'Pending',
  `paid_at` DATETIME DEFAULT NULL COMMENT 'Thời điểm thu/hoàn tiền thành công, GIỜ VN (NULL khi Pending/Failed)',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`payment_id`),
  UNIQUE KEY `uq_payments_tx_ref` (`transaction_ref`),
  KEY `idx_payments_booking` (`booking_id`, `payment_status`),
  KEY `idx_payments_processed_by` (`processed_by`),
  CONSTRAINT `fk_payments_booking` FOREIGN KEY (`booking_id`) REFERENCES `BOOKINGS` (`booking_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_payments_processed_by` FOREIGN KEY (`processed_by`) REFERENCES `USERS` (`user_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_payments_amount` CHECK (`amount` > 0),
  CONSTRAINT `chk_payments_ref` CHECK (CHAR_LENGTH(TRIM(`transaction_ref`)) > 0),
  CONSTRAINT `chk_payments_paid_at` CHECK (
    (`payment_status` IN ('Pending', 'Failed') AND `paid_at` IS NULL)
    OR (`payment_status` IN ('Success', 'Refunded') AND `paid_at` IS NOT NULL)
  ),
  CONSTRAINT `chk_payments_refund_status` CHECK (`payment_type` <> 'Refund' OR `payment_status` <> 'Refunded'),
  CONSTRAINT `chk_payments_cash_staff` CHECK (`payment_method` <> 'Cash' OR `processed_by` IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Sổ cái tiền: chỉ thêm mới, không xóa, không sửa số tiền (trigger bảo vệ)';

CREATE TABLE `booking_audit_logs` (
  `audit_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `booking_id` BIGINT UNSIGNED NOT NULL,
  `action_type` ENUM('CREATED', 'STATUS_CHANGED', 'RESCHEDULED', 'FINANCIAL_UPDATED',
                     'DETAILS_UPDATED', 'PAYMENT_CHANGED', 'ADDON_CHANGED') NOT NULL,
  `old_status` VARCHAR(20) DEFAULT NULL,
  `new_status` VARCHAR(20) DEFAULT NULL,
  `old_payload` JSON DEFAULT NULL,
  `new_payload` JSON DEFAULT NULL,
  `changed_by` BIGINT UNSIGNED DEFAULT NULL COMMENT 'Từ biến phiên @app_user_id do ứng dụng gán',
  `db_user` VARCHAR(128) NOT NULL COMMENT 'Tài khoản DB thực hiện (USER())',
  `created_at` TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`audit_id`),
  KEY `idx_audit_booking_time` (`booking_id`, `created_at`),
  KEY `idx_audit_actor_time` (`changed_by`, `created_at`),
  CONSTRAINT `fk_audit_booking` FOREIGN KEY (`booking_id`) REFERENCES `BOOKINGS` (`booking_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_audit_changed_by` FOREIGN KEY (`changed_by`) REFERENCES `USERS` (`user_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Nhật ký kiểm toán: chỉ INSERT (trigger chặn UPDATE/DELETE; cần REVOKE thêm ở mục 10)';

-- =====================================================================================
-- 9. PROCEDURES & TRIGGERS
-- =====================================================================================
DELIMITER $$

-- Xóa bản cũ (chạy lại an toàn, không đụng tới dữ liệu)
DROP TRIGGER IF EXISTS `trg_bookings_before_insert_guard`$$
DROP TRIGGER IF EXISTS `trg_bookings_before_update_guard`$$
DROP TRIGGER IF EXISTS `trg_bookings_after_insert_audit`$$
DROP TRIGGER IF EXISTS `trg_bookings_after_update_audit`$$
DROP TRIGGER IF EXISTS `trg_bookings_before_delete_guard`$$
DROP TRIGGER IF EXISTS `trg_payments_before_insert`$$
DROP TRIGGER IF EXISTS `trg_payments_after_insert`$$
DROP TRIGGER IF EXISTS `trg_payments_before_update`$$
DROP TRIGGER IF EXISTS `trg_payments_after_update`$$
DROP TRIGGER IF EXISTS `trg_payments_before_delete`$$
DROP TRIGGER IF EXISTS `trg_addons_before_insert`$$
DROP TRIGGER IF EXISTS `trg_addons_after_insert`$$
DROP TRIGGER IF EXISTS `trg_addons_before_update`$$
DROP TRIGGER IF EXISTS `trg_addons_after_update`$$
DROP TRIGGER IF EXISTS `trg_addons_before_delete`$$
DROP TRIGGER IF EXISTS `trg_addons_after_delete`$$
DROP TRIGGER IF EXISTS `trg_audit_before_update`$$
DROP TRIGGER IF EXISTS `trg_audit_before_delete`$$
DROP TRIGGER IF EXISTS `trg_users_before_insert_normalize`$$
DROP TRIGGER IF EXISTS `trg_users_before_update_normalize`$$
DROP TRIGGER IF EXISTS `trg_venues_before_insert_guard`$$
DROP TRIGGER IF EXISTS `trg_venues_before_update_guard`$$
DROP TRIGGER IF EXISTS `trg_pricing_before_insert_guard`$$
DROP TRIGGER IF EXISTS `trg_pricing_before_update_guard`$$
DROP PROCEDURE IF EXISTS `sp_lock_court_days`$$
DROP PROCEDURE IF EXISTS `sp_calc_booking_date`$$
DROP PROCEDURE IF EXISTS `sp_calc_booking_payments`$$
DROP PROCEDURE IF EXISTS `sp_sync_booking_payments`$$
DROP PROCEDURE IF EXISTS `sp_sync_booking_addons`$$
DROP PROCEDURE IF EXISTS `sp_write_audit`$$
DROP PROCEDURE IF EXISTS `sp_check_operating_hours`$$
DROP PROCEDURE IF EXISTS `sp_check_booking_people`$$
DROP PROCEDURE IF EXISTS `sp_check_booking_series`$$
DROP PROCEDURE IF EXISTS `sp_assert_facility_owner`$$
DROP PROCEDURE IF EXISTS `sp_assert_pricing_rule_unambiguous`$$
DROP FUNCTION IF EXISTS `fn_now_vn`$$

-- 9.0. Tiện ích: fn_now_vn (giờ VN, thay NOW()), kiểm tra nghiệp vụ, chống rule giá chồng chéo
CREATE FUNCTION `fn_now_vn`() RETURNS DATETIME
  NOT DETERMINISTIC NO SQL
BEGIN
  RETURN DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR);
END$$

CREATE PROCEDURE `sp_check_operating_hours`(
  IN p_facility_id BIGINT UNSIGNED,
  IN p_booking_date DATE,
  IN p_start_time DATETIME,
  IN p_end_time DATETIME
)
BEGIN
  DECLARE v_open_time TIME;
  DECLARE v_close_time TIME;
  DECLARE v_is_overnight TINYINT;
  DECLARE v_is_active TINYINT;
  DECLARE v_open_at DATETIME;
  DECLARE v_close_at DATETIME;

  SELECT MAX(`open_time`), MAX(`close_time`), MAX(`is_overnight`), MAX(`is_active`)
    INTO v_open_time, v_close_time, v_is_overnight, v_is_active
  FROM `FACILITIES`
  WHERE `facility_id` = p_facility_id AND `deleted_at` IS NULL;

  IF v_open_time IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'VENUE_UNAVAILABLE: Cụm sân không tồn tại hoặc đã bị xóa.';
  END IF;

  IF v_is_active = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'VENUE_UNAVAILABLE: Cụm sân đang ngưng hoạt động.';
  END IF;

  SET v_open_at = TIMESTAMP(p_booking_date, v_open_time);
  IF v_is_overnight = 1 THEN
    SET v_close_at = TIMESTAMP(DATE_ADD(p_booking_date, INTERVAL 1 DAY), v_close_time);
  ELSE
    SET v_close_at = TIMESTAMP(p_booking_date, v_close_time);
  END IF;

  IF p_start_time < v_open_at OR p_end_time > v_close_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'OUTSIDE_OPERATING_HOURS: Khung giờ đặt nằm ngoài giờ mở/đóng cửa của cụm sân.';
  END IF;
END$$

CREATE PROCEDURE `sp_check_booking_people`(
  IN p_user_id BIGINT UNSIGNED,
  IN p_checked_in_by BIGINT UNSIGNED
)
BEGIN
  DECLARE v_ok INT DEFAULT 0;

  SELECT COUNT(*) INTO v_ok
  FROM `USERS`
  WHERE `user_id` = p_user_id AND `status` = 'Active' AND `deleted_at` IS NULL;

  IF v_ok = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CUSTOMER_INVALID: Khách hàng không tồn tại, đang bị khóa hoặc đã bị xóa.';
  END IF;

  IF p_checked_in_by IS NOT NULL THEN
    SELECT COUNT(*) INTO v_ok
    FROM `USERS`
    WHERE `user_id` = p_checked_in_by AND `role` IN ('ADMIN', 'Staff')
      AND `status` = 'Active' AND `deleted_at` IS NULL;

    IF v_ok = 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'CHECKIN_STAFF_INVALID: Người check-in phải là Admin/Staff đang hoạt động.';
    END IF;
  END IF;
END$$

CREATE PROCEDURE `sp_check_booking_series`(
  IN p_series_id BIGINT UNSIGNED,
  IN p_facility_id BIGINT UNSIGNED,
  IN p_user_id BIGINT UNSIGNED,
  IN p_booking_date DATE
)
BEGIN
  DECLARE v_ok INT DEFAULT 0;

  IF p_series_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_ok
    FROM `booking_series`
    WHERE `series_id` = p_series_id
      AND `facility_id` = p_facility_id
      AND `user_id` = p_user_id
      AND `status` = 'Active'
      AND p_booking_date BETWEEN `series_start_date` AND `series_end_date`;

    IF v_ok = 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'SERIES_INVALID: Chuỗi đặt sân không còn Active hoặc ngày vận hành nằm ngoài khoảng của chuỗi.';
    END IF;
  END IF;
END$$

CREATE PROCEDURE `sp_assert_facility_owner`(IN p_user_id BIGINT UNSIGNED)
BEGIN
  DECLARE v_ok INT DEFAULT 0;

  SELECT COUNT(*) INTO v_ok
  FROM `USERS`
  WHERE `user_id` = p_user_id AND `role` = 'OWNER'
    AND `status` = 'Active' AND `deleted_at` IS NULL;

  IF v_ok = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'OWNER_INVALID: Chủ cụm sân phải có vai trò OWNER và đang hoạt động.';
  END IF;
END$$

CREATE PROCEDURE `sp_assert_pricing_rule_unambiguous`(
  IN p_rule_id BIGINT UNSIGNED,
  IN p_court_id BIGINT UNSIGNED,
  IN p_priority SMALLINT UNSIGNED,
  IN p_is_holiday TINYINT,
  IN p_mask TINYINT UNSIGNED,
  IN p_valid_from DATE,
  IN p_valid_to DATE,
  IN p_start_time TIME,
  IN p_end_time TIME,
  IN p_is_active TINYINT
)
BEGIN
  DECLARE v_s INT;
  DECLARE v_e INT;
  DECLARE v_conflict INT DEFAULT 0;

  IF p_is_active = 1 THEN
    SET v_s = TIME_TO_SEC(p_start_time);
    IF p_end_time <= p_start_time THEN
      SET v_e = TIME_TO_SEC(p_end_time) + 86400;
    ELSE
      SET v_e = TIME_TO_SEC(p_end_time);
    END IF;

    SELECT COUNT(*) INTO v_conflict
    FROM (
      SELECT TIME_TO_SEC(r.`start_time`) AS s,
             IF(r.`end_time` <= r.`start_time`,
                TIME_TO_SEC(r.`end_time`) + 86400,
                TIME_TO_SEC(r.`end_time`)) AS e
      FROM `pricing_rules` r
      WHERE r.`court_id` = p_court_id
        AND r.`rule_id` <> p_rule_id
        AND r.`is_active` = 1
        AND r.`priority` = p_priority
        AND r.`is_holiday_rule` = p_is_holiday
        AND (r.`days_of_week_mask` & p_mask) <> 0
        AND (r.`valid_from` IS NULL OR p_valid_to IS NULL OR r.`valid_from` <= p_valid_to)
        AND (r.`valid_to` IS NULL OR p_valid_from IS NULL OR r.`valid_to` >= p_valid_from)
    ) x
    WHERE (x.s < v_e AND v_s < x.e)
       OR (x.s + 86400 < v_e AND v_s < x.e + 86400)
       OR (x.s - 86400 < v_e AND v_s < x.e - 86400);

    IF v_conflict > 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'PRICING_RULE_AMBIGUOUS: Đã có rule cùng ưu tiên chồng chéo về thứ, ngày hiệu lực và khung giờ trên sân này.';
    END IF;
  END IF;
END$$

-- 9.0.1. Trigger USERS (chuẩn hóa SĐT), VENUES (kiểm tra manager), PRICING_RULES (chặn rule mơ hồ)
CREATE TRIGGER `trg_users_before_insert_normalize`
BEFORE INSERT ON `USERS`
FOR EACH ROW
BEGIN
  SET NEW.`phone` = REGEXP_REPLACE(TRIM(NEW.`phone`), '[ .-]', '');
  IF LEFT(NEW.`phone`, 3) = '+84' THEN
    SET NEW.`phone` = CONCAT('0', SUBSTRING(NEW.`phone`, 4));
  END IF;
END$$

CREATE TRIGGER `trg_users_before_update_normalize`
BEFORE UPDATE ON `USERS`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`phone` <=> OLD.`phone`) THEN
    SET NEW.`phone` = REGEXP_REPLACE(TRIM(NEW.`phone`), '[ .-]', '');
    IF LEFT(NEW.`phone`, 3) = '+84' THEN
      SET NEW.`phone` = CONCAT('0', SUBSTRING(NEW.`phone`, 4));
    END IF;
  END IF;
END$$

CREATE TRIGGER `trg_venues_before_insert_guard`
BEFORE INSERT ON `FACILITIES`
FOR EACH ROW
BEGIN
  CALL `sp_assert_facility_owner`(NEW.`owner_id`);
END$$

CREATE TRIGGER `trg_venues_before_update_guard`
BEFORE UPDATE ON `FACILITIES`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`owner_id` <=> OLD.`owner_id`) THEN
    CALL `sp_assert_facility_owner`(NEW.`owner_id`);
  END IF;
END$$

CREATE TRIGGER `trg_pricing_before_insert_guard`
BEFORE INSERT ON `pricing_rules`
FOR EACH ROW
BEGIN
  CALL `sp_assert_pricing_rule_unambiguous`(
    COALESCE(NEW.`rule_id`, 0), NEW.`court_id`, NEW.`priority`, NEW.`is_holiday_rule`, NEW.`days_of_week_mask`,
    NEW.`valid_from`, NEW.`valid_to`, NEW.`start_time`, NEW.`end_time`, NEW.`is_active`
  );
END$$

CREATE TRIGGER `trg_pricing_before_update_guard`
BEFORE UPDATE ON `pricing_rules`
FOR EACH ROW
BEGIN
  CALL `sp_assert_pricing_rule_unambiguous`(
    OLD.`rule_id`, NEW.`court_id`, NEW.`priority`, NEW.`is_holiday_rule`, NEW.`days_of_week_mask`,
    NEW.`valid_from`, NEW.`valid_to`, NEW.`start_time`, NEW.`end_time`, NEW.`is_active`
  );
END$$

-- 9.0.2. Khóa (sân, ngày lịch), tính ngày vận hành, đồng bộ tiền/dịch vụ, ghi audit
--   sp_lock_court_days luôn khóa ngày nhỏ trước (thứ tự cố định) để tránh deadlock.
CREATE PROCEDURE `sp_lock_court_days`(
  IN p_court_id BIGINT UNSIGNED,
  IN p_start_time DATETIME,
  IN p_end_time DATETIME
)
BEGIN
  DECLARE v_d1 DATE;
  DECLARE v_d2 DATE;

  SET v_d1 = DATE(p_start_time);
  SET v_d2 = DATE(p_end_time - INTERVAL 1 SECOND);

  INSERT INTO `court_day_locks` (`court_id`, `booking_date`)
  VALUES (p_court_id, v_d1)
  ON DUPLICATE KEY UPDATE `updated_at` = CURRENT_TIMESTAMP;

  IF v_d2 > v_d1 THEN
    INSERT INTO `court_day_locks` (`court_id`, `booking_date`)
    VALUES (p_court_id, v_d2)
    ON DUPLICATE KEY UPDATE `updated_at` = CURRENT_TIMESTAMP;
  END IF;
END$$

CREATE PROCEDURE `sp_calc_booking_date`(
  IN p_facility_id BIGINT UNSIGNED,
  IN p_start_time DATETIME,
  OUT p_booking_date DATE
)
BEGIN
  DECLARE v_open_time TIME;
  DECLARE v_is_overnight TINYINT;

  SELECT MAX(`open_time`), MAX(`is_overnight`)
    INTO v_open_time, v_is_overnight
  FROM `FACILITIES`
  WHERE `facility_id` = p_facility_id;

  IF v_is_overnight = 1 AND TIME(p_start_time) < v_open_time THEN
    SET p_booking_date = DATE_SUB(DATE(p_start_time), INTERVAL 1 DAY);
  ELSE
    SET p_booking_date = DATE(p_start_time);
  END IF;
END$$

CREATE PROCEDURE `sp_calc_booking_payments`(
  IN p_booking_id BIGINT UNSIGNED,
  OUT p_paid DECIMAL(12, 2),
  OUT p_refunded DECIMAL(12, 2)
)
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN p.`payment_type` <> 'Refund'
                       AND p.`payment_status` IN ('Success', 'Refunded') THEN p.`amount` END), 0),
    COALESCE(SUM(CASE WHEN p.`payment_type` = 'Refund'
                       AND p.`payment_status` = 'Success' THEN p.`amount` END), 0)
    INTO p_paid, p_refunded
  FROM `payments` p
  WHERE p.`booking_id` = p_booking_id
  FOR SHARE;
END$$

CREATE PROCEDURE `sp_sync_booking_payments`(IN p_booking_id BIGINT UNSIGNED)
BEGIN
  DECLARE v_paid DECIMAL(12, 2);
  DECLARE v_refunded DECIMAL(12, 2);

  CALL `sp_calc_booking_payments`(p_booking_id, v_paid, v_refunded);

  UPDATE `BOOKINGS`
     SET `paid_amount` = v_paid, `refunded_amount` = v_refunded
   WHERE `booking_id` = p_booking_id
     AND (`paid_amount` <> v_paid OR `refunded_amount` <> v_refunded);
END$$

CREATE PROCEDURE `sp_sync_booking_addons`(IN p_booking_id BIGINT UNSIGNED)
BEGIN
  DECLARE v_addons DECIMAL(12, 2);

  SELECT COALESCE(SUM(`line_total`), 0) INTO v_addons
  FROM `booking_addons`
  WHERE `booking_id` = p_booking_id
  FOR SHARE;

  UPDATE `BOOKINGS`
     SET `addons_amount` = v_addons
   WHERE `booking_id` = p_booking_id
     AND `addons_amount` <> v_addons;
END$$

CREATE PROCEDURE `sp_write_audit`(
  IN p_booking_id BIGINT UNSIGNED,
  IN p_action VARCHAR(30),
  IN p_old_status VARCHAR(20),
  IN p_new_status VARCHAR(20),
  IN p_old_payload JSON,
  IN p_new_payload JSON
)
BEGIN
  INSERT INTO `booking_audit_logs` (
    `booking_id`, `action_type`, `old_status`, `new_status`,
    `old_payload`, `new_payload`, `changed_by`, `db_user`
  ) VALUES (
    p_booking_id, p_action, p_old_status, p_new_status,
    p_old_payload, p_new_payload, CAST(@app_user_id AS UNSIGNED), USER()
  );
END$$

-- -------------------------------------------------------------------------------------
-- 9.1. BOOKINGS - BEFORE INSERT
-- -------------------------------------------------------------------------------------
CREATE TRIGGER `trg_bookings_before_insert_guard`
BEFORE INSERT ON `BOOKINGS`
FOR EACH ROW
BEGIN
  DECLARE v_conflict_count INT DEFAULT 0;
  DECLARE v_invalid_court_count INT DEFAULT 0;
  DECLARE v_booking_date DATE;
  DECLARE v_requires_approval BOOLEAN DEFAULT FALSE;

  IF NEW.`end_time` <= NEW.`start_time` THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'INVALID_TIME_RANGE: end_time phải lớn hơn start_time.';
  END IF;

  IF NEW.`status` NOT IN ('Pending', 'Deposit_Paid', 'Fully_Paid') THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'INVALID_INITIAL_STATUS: Đơn mới chỉ được tạo với Pending, Deposit_Paid hoặc Fully_Paid.';
  END IF;

  IF NEW.`paid_amount` <> 0 OR NEW.`refunded_amount` <> 0 OR NEW.`addons_amount` <> 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'MONEY_GUARD: paid/refunded/addons chỉ được cập nhật tự động từ payments và booking_addons.';
  END IF;

  IF (NEW.`status` = 'Fully_Paid' AND (NEW.`court_rental_amount` - NEW.`discount_amount`) > 0)
     OR (NEW.`status` = 'Deposit_Paid' AND NEW.`deposit_required` > 0) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'FUNDING_REQUIRED: Số tiền đã thanh toán chưa đủ để tạo đơn ở trạng thái này.';
  END IF;

  IF NEW.`status` = 'Pending' THEN
    IF NEW.`end_time` <= fn_now_vn() THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'BOOKING_IN_PAST: Không thể giữ chỗ cho khung giờ đã kết thúc.';
    END IF;

    IF NEW.`hold_expires_at` IS NULL THEN
      SET NEW.`hold_expires_at` = DATE_ADD(fn_now_vn(), INTERVAL 10 MINUTE);
    ELSEIF NEW.`hold_expires_at` <= fn_now_vn()
           OR NEW.`hold_expires_at` > DATE_ADD(fn_now_vn(), INTERVAL 30 MINUTE) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'HOLD_INVALID: hold_expires_at phải nằm trong khoảng (bây giờ, bây giờ + 30 phút].';
    END IF;
  ELSE
    SET NEW.`hold_expires_at` = NULL;
  END IF;

  CALL `sp_calc_booking_date`(NEW.`facility_id`, NEW.`start_time`, v_booking_date);
  SET NEW.`booking_date` = v_booking_date;

  CALL `sp_check_operating_hours`(NEW.`facility_id`, v_booking_date, NEW.`start_time`, NEW.`end_time`);
  CALL `sp_check_booking_people`(NEW.`user_id`, NEW.`checked_in_by`);
  CALL `sp_check_booking_series`(NEW.`series_id`, NEW.`facility_id`, NEW.`user_id`, v_booking_date);

  CALL `sp_lock_court_days`(NEW.`court_id`, NEW.`start_time`, NEW.`end_time`);

  SELECT COALESCE(MAX(`requires_approval`), FALSE) INTO v_requires_approval
  FROM `COURTS` WHERE `court_id` = NEW.`court_id`;
  SET NEW.`approval_status` = IF(v_requires_approval, 'Pending', 'Confirmed');
  IF v_requires_approval AND NEW.`status` <> 'Pending' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'APPROVAL_REQUIRED: Sân cần được duyệt trước khi chuyển trạng thái thanh toán.';
  END IF;

  SELECT COUNT(*) INTO v_invalid_court_count
  FROM `COURTS` c
  WHERE c.`court_id` = NEW.`court_id`
    AND (c.`status` <> 'Available' OR c.`deleted_at` IS NOT NULL);

  IF v_invalid_court_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'COURT_UNAVAILABLE: Sân đang bảo trì hoặc ngưng hoạt động.';
  END IF;

  SELECT COUNT(*) INTO v_conflict_count
  FROM `BOOKINGS` b
  WHERE b.`court_id` = NEW.`court_id`
    AND b.`is_active_slot` = 1
    AND (b.`status` <> 'Pending' OR b.`hold_expires_at` > fn_now_vn())
    AND b.`start_time` < NEW.`end_time`
    AND b.`end_time` > NEW.`start_time`
    AND b.`start_time` > DATE_SUB(NEW.`start_time`, INTERVAL 12 HOUR)
  FOR SHARE;

  IF v_conflict_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'OVERBOOKING_CONFLICT: Khung giờ đã có người đặt trên sân này.';
  END IF;
END$$

-- -------------------------------------------------------------------------------------
-- 9.2. BOOKINGS - BEFORE UPDATE
-- -------------------------------------------------------------------------------------
CREATE TRIGGER `trg_bookings_before_update_guard`
BEFORE UPDATE ON `BOOKINGS`
FOR EACH ROW
BEGIN
  DECLARE v_conflict_count INT DEFAULT 0;
  DECLARE v_invalid_court_count INT DEFAULT 0;
  DECLARE v_booking_date DATE;
  DECLARE v_paid DECIMAL(12, 2);
  DECLARE v_refunded DECIMAL(12, 2);
  DECLARE v_addons DECIMAL(12, 2);
  DECLARE v_requires_approval BOOLEAN DEFAULT FALSE;
  DECLARE v_manager_count INT DEFAULT 0;

  -- Đổi lịch hoặc khôi phục đơn chưa thanh toán phải xét lại yêu cầu duyệt.
  IF OLD.`status` IN ('Pending', 'Cancelled', 'Expired')
     AND NEW.`status` IN ('Pending', 'Deposit_Paid', 'Fully_Paid')
     AND (OLD.`status` <> 'Pending' OR NEW.`court_id` <> OLD.`court_id`
          OR NEW.`start_time` <> OLD.`start_time` OR NEW.`end_time` <> OLD.`end_time`
          OR NEW.`user_id` <> OLD.`user_id`) THEN
    SELECT COALESCE(MAX(`requires_approval`), FALSE) INTO v_requires_approval
    FROM `COURTS` WHERE `court_id` = NEW.`court_id`;
    SET NEW.`approval_status` = IF(v_requires_approval, 'Pending', 'Confirmed');
  ELSEIF NEW.`approval_status` <> OLD.`approval_status` THEN
    SELECT COUNT(*) INTO v_manager_count
    FROM `FACILITIES` v JOIN `USERS` u ON u.`user_id` = v.`owner_id`
    WHERE v.`facility_id` = OLD.`facility_id` AND u.`user_id` = @app_user_id
      AND u.`role` = 'OWNER' AND u.`status` = 'Active' AND u.`deleted_at` IS NULL;

    IF v_manager_count = 0 OR OLD.`approval_status` <> 'Pending' OR OLD.`status` <> 'Pending'
       OR OLD.`hold_expires_at` <= fn_now_vn()
       OR NOT ((NEW.`approval_status` = 'Confirmed' AND NEW.`status` = 'Pending')
            OR (NEW.`approval_status` = 'Rejected' AND NEW.`status` = 'Cancelled')) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'APPROVAL_INVALID: Quản lý cụm sân chỉ được xử lý đơn đang chờ duyệt còn hạn.';
    END IF;
  END IF;

  IF NEW.`approval_status` <> 'Confirmed' AND NEW.`status` IN ('Deposit_Paid', 'Fully_Paid', 'Completed') THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'APPROVAL_REQUIRED: Đơn phải được xác nhận trước khi chuyển trạng thái thanh toán.';
  END IF;

  IF NEW.`facility_id` <> OLD.`facility_id` OR NEW.`booking_code` <> OLD.`booking_code` THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'IMMUTABLE_FIELD: Không được đổi facility_id hoặc booking_code của đơn đã tạo.';
  END IF;

  IF OLD.`status` = 'Completed' THEN
    IF NEW.`status` <> 'Completed' THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'INVALID_STATE_TRANSITION: Không thể thay đổi trạng thái của đơn đặt sân đã hoàn thành (Completed).';
    END IF;

    IF NEW.`court_id` <> OLD.`court_id`
       OR NEW.`start_time` <> OLD.`start_time`
       OR NEW.`end_time` <> OLD.`end_time`
       OR NEW.`user_id` <> OLD.`user_id`
       OR NEW.`court_rental_amount` <> OLD.`court_rental_amount`
       OR NEW.`discount_amount` <> OLD.`discount_amount`
       OR NEW.`addons_amount` <> OLD.`addons_amount`
       OR NEW.`deposit_required` <> OLD.`deposit_required` THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'COMPLETED_IMMUTABLE: Đơn đã hoàn thành không được sửa sân, giờ, khách hoặc các khoản tiền.';
    END IF;
  END IF;

  IF NEW.`status` <> OLD.`status` THEN
    IF NOT (
         (OLD.`status` = 'Pending'      AND NEW.`status` IN ('Deposit_Paid', 'Fully_Paid', 'Cancelled', 'Expired'))
      OR (OLD.`status` = 'Deposit_Paid' AND NEW.`status` IN ('Fully_Paid', 'Completed', 'Cancelled'))
      OR (OLD.`status` = 'Fully_Paid'   AND NEW.`status` IN ('Completed', 'Cancelled'))
      OR (OLD.`status` IN ('Cancelled', 'Expired') AND NEW.`status` = 'Pending')
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'INVALID_STATE_TRANSITION: Chuyển trạng thái không nằm trong ma trận cho phép.';
    END IF;

    IF NEW.`status` = 'Expired' AND OLD.`hold_expires_at` > fn_now_vn() THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'EXPIRE_TOO_EARLY: Đơn Pending chưa quá hold_expires_at nên chưa thể chuyển sang Expired.';
    END IF;
  END IF;

  IF NEW.`paid_amount` <> OLD.`paid_amount` OR NEW.`refunded_amount` <> OLD.`refunded_amount` THEN
    CALL `sp_calc_booking_payments`(NEW.`booking_id`, v_paid, v_refunded);
    IF NEW.`paid_amount` <> v_paid OR NEW.`refunded_amount` <> v_refunded THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'MONEY_GUARD: paid/refunded phải khớp tổng các giao dịch trong bảng payments.';
    END IF;
  END IF;

  IF NEW.`addons_amount` <> OLD.`addons_amount` THEN
    SELECT COALESCE(SUM(`line_total`), 0) INTO v_addons
    FROM `booking_addons`
    WHERE `booking_id` = NEW.`booking_id`
    FOR SHARE;
    IF NEW.`addons_amount` <> v_addons THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'MONEY_GUARD: addons_amount phải khớp tổng line_total trong booking_addons.';
    END IF;
  END IF;

  IF NEW.`status` <> OLD.`status` THEN
    IF NEW.`status` = 'Fully_Paid'
       AND (NEW.`paid_amount` - NEW.`refunded_amount`)
           < (NEW.`court_rental_amount` + NEW.`addons_amount` - NEW.`discount_amount`) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'FUNDING_REQUIRED: Chưa thanh toán đủ tổng tiền để chuyển sang Fully_Paid.';
    END IF;

    IF NEW.`status` = 'Deposit_Paid'
       AND (NEW.`paid_amount` - NEW.`refunded_amount`) < NEW.`deposit_required` THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'FUNDING_REQUIRED: Chưa thanh toán đủ tiền cọc để chuyển sang Deposit_Paid.';
    END IF;

    IF NEW.`status` = 'Completed' THEN
      IF NEW.`start_time` > fn_now_vn() THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'COMPLETE_TOO_EARLY: Chưa đến giờ bắt đầu nên chưa thể chuyển sang Completed.';
      END IF;

      IF (NEW.`paid_amount` - NEW.`refunded_amount`)
         < (NEW.`court_rental_amount` + NEW.`addons_amount` - NEW.`discount_amount`) THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'FUNDING_REQUIRED: Phải thanh toán đủ tổng tiền trước khi chuyển sang Completed.';
      END IF;
    END IF;
  END IF;

  IF NEW.`status` = 'Pending' THEN
    IF OLD.`status` <> 'Pending' THEN
      SET NEW.`hold_expires_at` = DATE_ADD(fn_now_vn(), INTERVAL 10 MINUTE);
    ELSEIF NOT (NEW.`hold_expires_at` <=> OLD.`hold_expires_at`) THEN
      IF NEW.`hold_expires_at` IS NULL OR NEW.`hold_expires_at` > OLD.`hold_expires_at` THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'HOLD_INVALID: Đơn Pending không được xóa hoặc gia hạn hold_expires_at (chỉ được rút ngắn).';
      END IF;
    END IF;
  ELSEIF NEW.`status` IN ('Deposit_Paid', 'Fully_Paid', 'Completed') THEN
    SET NEW.`hold_expires_at` = NULL;
  END IF;

  IF NEW.`start_time` <> OLD.`start_time` OR NEW.`booking_date` <> OLD.`booking_date` THEN
    CALL `sp_calc_booking_date`(NEW.`facility_id`, NEW.`start_time`, v_booking_date);
    SET NEW.`booking_date` = v_booking_date;
  END IF;

  IF NEW.`status` IN ('Pending', 'Deposit_Paid', 'Fully_Paid') AND (
       NEW.`court_id` <> OLD.`court_id`
    OR NEW.`start_time` <> OLD.`start_time`
    OR NEW.`end_time` <> OLD.`end_time`
    OR OLD.`status` IN ('Cancelled', 'Expired')
    OR (OLD.`approval_status` = 'Pending' AND NEW.`approval_status` = 'Confirmed')
  ) THEN
    CALL `sp_check_operating_hours`(NEW.`facility_id`, NEW.`booking_date`, NEW.`start_time`, NEW.`end_time`);
  END IF;

  IF NOT (NEW.`user_id` <=> OLD.`user_id` AND NEW.`checked_in_by` <=> OLD.`checked_in_by`) THEN
    CALL `sp_check_booking_people`(NEW.`user_id`, NEW.`checked_in_by`);
  END IF;

  IF NOT (NEW.`series_id` <=> OLD.`series_id`) OR NEW.`start_time` <> OLD.`start_time` THEN
    CALL `sp_check_booking_series`(NEW.`series_id`, NEW.`facility_id`, NEW.`user_id`, NEW.`booking_date`);
  END IF;

  IF NEW.`status` IN ('Pending', 'Deposit_Paid', 'Fully_Paid', 'Completed') AND (
       NEW.`court_id` <> OLD.`court_id`
    OR NEW.`start_time` <> OLD.`start_time`
    OR NEW.`end_time` <> OLD.`end_time`
    OR OLD.`status` IN ('Cancelled', 'Expired')
    OR (OLD.`approval_status` = 'Pending' AND NEW.`approval_status` = 'Confirmed')
    OR (OLD.`status` = 'Pending' AND NEW.`status` IN ('Deposit_Paid', 'Fully_Paid'))
  ) THEN
    IF NEW.`end_time` <= NEW.`start_time` THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'INVALID_TIME_RANGE: end_time phải lớn hơn start_time.';
    END IF;

    CALL `sp_lock_court_days`(NEW.`court_id`, NEW.`start_time`, NEW.`end_time`);

    IF NEW.`court_id` <> OLD.`court_id` OR OLD.`status` IN ('Cancelled', 'Expired')
       OR (OLD.`approval_status` = 'Pending' AND NEW.`approval_status` = 'Confirmed') THEN
      SELECT COUNT(*) INTO v_invalid_court_count
      FROM `COURTS` c
      WHERE c.`court_id` = NEW.`court_id`
        AND (c.`status` <> 'Available' OR c.`deleted_at` IS NOT NULL);

      IF v_invalid_court_count > 0 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'COURT_UNAVAILABLE: Sân đang bảo trì hoặc ngưng hoạt động.';
      END IF;
    END IF;

    SELECT COUNT(*) INTO v_conflict_count
    FROM `BOOKINGS` b
    WHERE b.`court_id` = NEW.`court_id`
      AND b.`booking_id` <> NEW.`booking_id`
      AND b.`is_active_slot` = 1
      AND (b.`status` <> 'Pending' OR b.`hold_expires_at` > fn_now_vn())
      AND b.`start_time` < NEW.`end_time`
      AND b.`end_time` > NEW.`start_time`
      AND b.`start_time` > DATE_SUB(NEW.`start_time`, INTERVAL 12 HOUR)
    FOR SHARE;

    IF v_conflict_count > 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'LATE_WEBHOOK_OR_RESCHEDULE_CONFLICT: Khung giờ đã bị người khác đặt trong lúc đơn hết hạn giữ chỗ.';
    END IF;
  END IF;

  SET NEW.`version` = OLD.`version` + 1;
END$$

-- -------------------------------------------------------------------------------------
-- 9.3. BOOKINGS - AUDIT (INSERT + UPDATE) và chặn DELETE
-- -------------------------------------------------------------------------------------
CREATE TRIGGER `trg_bookings_after_insert_audit`
AFTER INSERT ON `BOOKINGS`
FOR EACH ROW
BEGIN
  CALL `sp_write_audit`(
    NEW.`booking_id`, 'CREATED', NULL, NEW.`status`, NULL,
    JSON_OBJECT(
      'user_id', NEW.`user_id`, 'court_id', NEW.`court_id`, 'booking_date', NEW.`booking_date`,
      'start_time', NEW.`start_time`, 'end_time', NEW.`end_time`, 'status', NEW.`status`,
      'court_rental_amount', NEW.`court_rental_amount`, 'addons_amount', NEW.`addons_amount`,
      'discount_amount', NEW.`discount_amount`, 'deposit_required', NEW.`deposit_required`,
      'paid_amount', NEW.`paid_amount`, 'refunded_amount', NEW.`refunded_amount`,
      'hold_expires_at', NEW.`hold_expires_at`, 'cancel_reason', NEW.`cancel_reason`,
      'checked_in_by', NEW.`checked_in_by`, 'approval_status', NEW.`approval_status`
    )
  );
END$$

CREATE TRIGGER `trg_bookings_after_update_audit`
AFTER UPDATE ON `BOOKINGS`
FOR EACH ROW
BEGIN
  IF NOT (
        OLD.`status` <=> NEW.`status`
    AND OLD.`approval_status` <=> NEW.`approval_status`
    AND OLD.`user_id` <=> NEW.`user_id`
    AND OLD.`court_id` <=> NEW.`court_id`
    AND OLD.`booking_date` <=> NEW.`booking_date`
    AND OLD.`start_time` <=> NEW.`start_time`
    AND OLD.`end_time` <=> NEW.`end_time`
    AND OLD.`court_rental_amount` <=> NEW.`court_rental_amount`
    AND OLD.`addons_amount` <=> NEW.`addons_amount`
    AND OLD.`discount_amount` <=> NEW.`discount_amount`
    AND OLD.`deposit_required` <=> NEW.`deposit_required`
    AND OLD.`paid_amount` <=> NEW.`paid_amount`
    AND OLD.`refunded_amount` <=> NEW.`refunded_amount`
    AND OLD.`hold_expires_at` <=> NEW.`hold_expires_at`
    AND OLD.`cancel_reason` <=> NEW.`cancel_reason`
    AND OLD.`checked_in_by` <=> NEW.`checked_in_by`
  ) THEN
    CALL `sp_write_audit`(
      NEW.`booking_id`,
      CASE
        WHEN NOT (OLD.`status` <=> NEW.`status`) THEN 'STATUS_CHANGED'
        WHEN NOT (OLD.`start_time` <=> NEW.`start_time` AND OLD.`end_time` <=> NEW.`end_time`
                  AND OLD.`court_id` <=> NEW.`court_id`) THEN 'RESCHEDULED'
        WHEN NOT (OLD.`court_rental_amount` <=> NEW.`court_rental_amount`
                  AND OLD.`addons_amount` <=> NEW.`addons_amount`
                  AND OLD.`discount_amount` <=> NEW.`discount_amount`
                  AND OLD.`deposit_required` <=> NEW.`deposit_required`
                  AND OLD.`paid_amount` <=> NEW.`paid_amount`
                  AND OLD.`refunded_amount` <=> NEW.`refunded_amount`) THEN 'FINANCIAL_UPDATED'
        ELSE 'DETAILS_UPDATED'
      END,
      OLD.`status`,
      NEW.`status`,
      JSON_OBJECT(
        'user_id', OLD.`user_id`, 'court_id', OLD.`court_id`, 'booking_date', OLD.`booking_date`,
        'start_time', OLD.`start_time`, 'end_time', OLD.`end_time`, 'status', OLD.`status`,
        'court_rental_amount', OLD.`court_rental_amount`, 'addons_amount', OLD.`addons_amount`,
        'discount_amount', OLD.`discount_amount`, 'deposit_required', OLD.`deposit_required`,
        'paid_amount', OLD.`paid_amount`, 'refunded_amount', OLD.`refunded_amount`,
        'hold_expires_at', OLD.`hold_expires_at`, 'cancel_reason', OLD.`cancel_reason`,
        'checked_in_by', OLD.`checked_in_by`, 'approval_status', OLD.`approval_status`
      ),
      JSON_OBJECT(
        'user_id', NEW.`user_id`, 'court_id', NEW.`court_id`, 'booking_date', NEW.`booking_date`,
        'start_time', NEW.`start_time`, 'end_time', NEW.`end_time`, 'status', NEW.`status`,
        'court_rental_amount', NEW.`court_rental_amount`, 'addons_amount', NEW.`addons_amount`,
        'discount_amount', NEW.`discount_amount`, 'deposit_required', NEW.`deposit_required`,
        'paid_amount', NEW.`paid_amount`, 'refunded_amount', NEW.`refunded_amount`,
        'hold_expires_at', NEW.`hold_expires_at`, 'cancel_reason', NEW.`cancel_reason`,
        'checked_in_by', NEW.`checked_in_by`, 'approval_status', NEW.`approval_status`
      )
    );
  END IF;
END$$

-- Booking là chứng từ tài chính: không xóa, chỉ chuyển sang Cancelled/Expired.
CREATE TRIGGER `trg_bookings_before_delete_guard`
BEFORE DELETE ON `BOOKINGS`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'DELETE_FORBIDDEN: Không được xóa booking, hãy chuyển trạng thái sang Cancelled hoặc Expired.';
END$$

-- -------------------------------------------------------------------------------------
-- 9.4. PAYMENTS - sổ cái chỉ thêm, đồng bộ vào bookings, có audit
-- Trigger BEFORE khóa X dòng booking trước khi FK check lấy khóa S (tránh deadlock S->X).
-- -------------------------------------------------------------------------------------
CREATE TRIGGER `trg_payments_before_insert`
BEFORE INSERT ON `payments`
FOR EACH ROW
BEGIN
  DECLARE v_status VARCHAR(20);
  DECLARE v_paid DECIMAL(12, 2);
  DECLARE v_refunded DECIMAL(12, 2);

  SELECT MAX(`status`) INTO v_status
  FROM `BOOKINGS`
  WHERE `booking_id` = NEW.`booking_id`
  FOR UPDATE;

  IF v_status IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'BOOKING_NOT_FOUND: Không tìm thấy booking để ghi nhận giao dịch.';
  END IF;

  IF NEW.`payment_status` = 'Refunded' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'PAYMENT_INVALID_STATUS: Giao dịch mới không được tạo ở trạng thái Refunded.';
  END IF;

  IF NEW.`payment_status` = 'Success' AND NEW.`paid_at` IS NULL THEN
    SET NEW.`paid_at` = fn_now_vn();
  END IF;

  IF NEW.`payment_type` = 'Refund' THEN
    IF v_status NOT IN ('Cancelled', 'Expired') THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'REFUND_NOT_ALLOWED: Chỉ được hoàn tiền cho đơn đã Cancelled hoặc Expired.';
    END IF;

    IF NEW.`payment_status` = 'Success' THEN
      CALL `sp_calc_booking_payments`(NEW.`booking_id`, v_paid, v_refunded);
      IF NEW.`amount` > (v_paid - v_refunded) THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'REFUND_EXCEEDS_PAID: Số tiền hoàn vượt quá số tiền đã thu còn lại của đơn.';
      END IF;
    END IF;
  END IF;
END$$

CREATE TRIGGER `trg_payments_after_insert`
AFTER INSERT ON `payments`
FOR EACH ROW
BEGIN
  CALL `sp_sync_booking_payments`(NEW.`booking_id`);

  CALL `sp_write_audit`(
    NEW.`booking_id`, 'PAYMENT_CHANGED', NULL, NEW.`payment_status`, NULL,
    JSON_OBJECT(
      'payment_id', NEW.`payment_id`, 'payment_type', NEW.`payment_type`,
      'payment_method', NEW.`payment_method`, 'amount', NEW.`amount`,
      'transaction_ref', NEW.`transaction_ref`, 'payment_status', NEW.`payment_status`,
      'paid_at', NEW.`paid_at`, 'processed_by', NEW.`processed_by`
    )
  );
END$$

CREATE TRIGGER `trg_payments_before_update`
BEFORE UPDATE ON `payments`
FOR EACH ROW
BEGIN
  DECLARE v_lock INT DEFAULT 0;
  DECLARE v_paid DECIMAL(12, 2);
  DECLARE v_refunded DECIMAL(12, 2);

  IF NEW.`booking_id` <> OLD.`booking_id`
     OR NEW.`payment_type` <> OLD.`payment_type`
     OR NEW.`payment_method` <> OLD.`payment_method`
     OR NEW.`amount` <> OLD.`amount`
     OR NEW.`transaction_ref` <> OLD.`transaction_ref` THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'PAYMENT_IMMUTABLE: Không được sửa booking, loại, phương thức, số tiền hoặc mã giao dịch.';
  END IF;

  IF NEW.`payment_status` <> OLD.`payment_status` THEN
    IF OLD.`payment_status` IN ('Failed', 'Refunded')
       OR (OLD.`payment_status` = 'Success' AND NEW.`payment_status` <> 'Refunded') THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'PAYMENT_STATE_LOCKED: Giao dịch ở trạng thái cuối, không được chuyển trạng thái.';
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_lock
  FROM `BOOKINGS`
  WHERE `booking_id` = OLD.`booking_id`
  FOR UPDATE;

  IF NEW.`payment_status` = 'Success' AND OLD.`payment_status` <> 'Success' AND NEW.`paid_at` IS NULL THEN
    SET NEW.`paid_at` = fn_now_vn();
  END IF;

  IF NEW.`payment_type` = 'Refund' AND OLD.`payment_status` <> 'Success' AND NEW.`payment_status` = 'Success' THEN
    CALL `sp_calc_booking_payments`(NEW.`booking_id`, v_paid, v_refunded);
    IF NEW.`amount` > (v_paid - v_refunded) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'REFUND_EXCEEDS_PAID: Số tiền hoàn vượt quá số tiền đã thu còn lại của đơn.';
    END IF;
  END IF;
END$$

CREATE TRIGGER `trg_payments_after_update`
AFTER UPDATE ON `payments`
FOR EACH ROW
BEGIN
  IF NOT (OLD.`payment_status` <=> NEW.`payment_status`
          AND OLD.`paid_at` <=> NEW.`paid_at`
          AND OLD.`processed_by` <=> NEW.`processed_by`) THEN
    CALL `sp_sync_booking_payments`(NEW.`booking_id`);

    CALL `sp_write_audit`(
      NEW.`booking_id`, 'PAYMENT_CHANGED', OLD.`payment_status`, NEW.`payment_status`,
      JSON_OBJECT(
        'payment_id', OLD.`payment_id`, 'payment_status', OLD.`payment_status`,
        'paid_at', OLD.`paid_at`, 'processed_by', OLD.`processed_by`, 'amount', OLD.`amount`
      ),
      JSON_OBJECT(
        'payment_id', NEW.`payment_id`, 'payment_status', NEW.`payment_status`,
        'paid_at', NEW.`paid_at`, 'processed_by', NEW.`processed_by`, 'amount', NEW.`amount`
      )
    );
  END IF;
END$$

CREATE TRIGGER `trg_payments_before_delete`
BEFORE DELETE ON `payments`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'DELETE_FORBIDDEN: Không được xóa giao dịch; hãy tạo giao dịch Refund để đảo chiều.';
END$$

-- -------------------------------------------------------------------------------------
-- 9.5. BOOKING_ADDONS - đồng bộ addons_amount, kiểm tra giá, audit
-- -------------------------------------------------------------------------------------
CREATE TRIGGER `trg_addons_before_insert`
BEFORE INSERT ON `booking_addons`
FOR EACH ROW
BEGIN
  DECLARE v_booking_ok INT DEFAULT 0;
  DECLARE v_price DECIMAL(12, 2);

  SELECT COUNT(*) INTO v_booking_ok
  FROM `BOOKINGS`
  WHERE `booking_id` = NEW.`booking_id`
    AND `status` IN ('Pending', 'Deposit_Paid', 'Fully_Paid')
  FOR UPDATE;

  IF v_booking_ok = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ADDON_NOT_ALLOWED: Chỉ được thêm dịch vụ cho đơn Pending, Deposit_Paid hoặc Fully_Paid.';
  END IF;

  SELECT MAX(`unit_price`) INTO v_price
  FROM `services`
  WHERE `facility_id` = NEW.`facility_id` AND `service_id` = NEW.`service_id`
    AND `is_active` = 1 AND `deleted_at` IS NULL;

  IF v_price IS NULL OR NEW.`unit_price` <> v_price THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ADDON_PRICE_MISMATCH: Dịch vụ không còn bán, hoặc unit_price khác đơn giá hiện hành.';
  END IF;
END$$

CREATE TRIGGER `trg_addons_after_insert`
AFTER INSERT ON `booking_addons`
FOR EACH ROW
BEGIN
  CALL `sp_sync_booking_addons`(NEW.`booking_id`);

  CALL `sp_write_audit`(
    NEW.`booking_id`, 'ADDON_CHANGED', NULL, NULL, NULL,
    JSON_OBJECT('addon_id', NEW.`addon_id`, 'service_id', NEW.`service_id`,
                'quantity', NEW.`quantity`, 'unit_price', NEW.`unit_price`)
  );
END$$

CREATE TRIGGER `trg_addons_before_update`
BEFORE UPDATE ON `booking_addons`
FOR EACH ROW
BEGIN
  DECLARE v_booking_ok INT DEFAULT 0;

  IF NEW.`booking_id` <> OLD.`booking_id`
     OR NEW.`facility_id` <> OLD.`facility_id`
     OR NEW.`service_id` <> OLD.`service_id`
     OR NEW.`unit_price` <> OLD.`unit_price` THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ADDON_IMMUTABLE: Chỉ được sửa số lượng; muốn đổi dịch vụ hoặc giá hãy xóa và thêm dòng mới.';
  END IF;

  SELECT COUNT(*) INTO v_booking_ok
  FROM `BOOKINGS`
  WHERE `booking_id` = OLD.`booking_id`
    AND `status` IN ('Pending', 'Deposit_Paid', 'Fully_Paid')
  FOR UPDATE;

  IF v_booking_ok = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ADDON_NOT_ALLOWED: Chỉ được sửa dịch vụ của đơn Pending, Deposit_Paid hoặc Fully_Paid.';
  END IF;
END$$

CREATE TRIGGER `trg_addons_after_update`
AFTER UPDATE ON `booking_addons`
FOR EACH ROW
BEGIN
  IF OLD.`quantity` <> NEW.`quantity` THEN
    CALL `sp_sync_booking_addons`(NEW.`booking_id`);

    CALL `sp_write_audit`(
      NEW.`booking_id`, 'ADDON_CHANGED', NULL, NULL,
      JSON_OBJECT('addon_id', OLD.`addon_id`, 'service_id', OLD.`service_id`,
                  'quantity', OLD.`quantity`, 'unit_price', OLD.`unit_price`),
      JSON_OBJECT('addon_id', NEW.`addon_id`, 'service_id', NEW.`service_id`,
                  'quantity', NEW.`quantity`, 'unit_price', NEW.`unit_price`)
    );
  END IF;
END$$

CREATE TRIGGER `trg_addons_before_delete`
BEFORE DELETE ON `booking_addons`
FOR EACH ROW
BEGIN
  DECLARE v_booking_ok INT DEFAULT 0;

  SELECT COUNT(*) INTO v_booking_ok
  FROM `BOOKINGS`
  WHERE `booking_id` = OLD.`booking_id`
    AND `status` IN ('Pending', 'Deposit_Paid', 'Fully_Paid')
  FOR UPDATE;

  IF v_booking_ok = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ADDON_NOT_ALLOWED: Chỉ được xóa dịch vụ của đơn Pending, Deposit_Paid hoặc Fully_Paid.';
  END IF;
END$$

CREATE TRIGGER `trg_addons_after_delete`
AFTER DELETE ON `booking_addons`
FOR EACH ROW
BEGIN
  CALL `sp_sync_booking_addons`(OLD.`booking_id`);

  CALL `sp_write_audit`(
    OLD.`booking_id`, 'ADDON_CHANGED', NULL, NULL,
    JSON_OBJECT('addon_id', OLD.`addon_id`, 'service_id', OLD.`service_id`,
                'quantity', OLD.`quantity`, 'unit_price', OLD.`unit_price`),
    NULL
  );
END$$

-- -------------------------------------------------------------------------------------
-- 9.6. Bảng audit bất biến ở mức trigger (TRUNCATE/DROP cần REVOKE, xem mục 10)
-- -------------------------------------------------------------------------------------
CREATE TRIGGER `trg_audit_before_update`
BEFORE UPDATE ON `booking_audit_logs`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'AUDIT_IMMUTABLE: Nhật ký kiểm toán không được sửa.';
END$$

CREATE TRIGGER `trg_audit_before_delete`
BEFORE DELETE ON `booking_audit_logs`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'AUDIT_IMMUTABLE: Nhật ký kiểm toán không được xóa.';
END$$

DELIMITER ;

-- =====================================================================================
-- 10. PHÂN QUYỀN GỢI Ý (bỏ comment và chỉnh tên tài khoản/host cho phù hợp)
-- =====================================================================================
--
-- CREATE USER 'courtpulse_app'@'%' IDENTIFIED BY '<mật-khẩu-mạnh>';
-- GRANT SELECT, INSERT, UPDATE ON sports_court_booking.* TO 'courtpulse_app'@'%';
-- GRANT EXECUTE ON sports_court_booking.* TO 'courtpulse_app'@'%';
-- REVOKE INSERT, UPDATE, DELETE ON sports_court_booking.booking_audit_logs FROM 'courtpulse_app'@'%';
-- REVOKE INSERT, UPDATE, DELETE ON sports_court_booking.court_day_locks   FROM 'courtpulse_app'@'%';
-- Không cấp DROP / TRUNCATE / ALTER / TRIGGER cho tài khoản ứng dụng.
--
-- Cấu hình my.cnf khuyến nghị:
--   [mysqld]
--   default-time-zone = '+07:00'
--   transaction-isolation = READ-COMMITTED
--   sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'
