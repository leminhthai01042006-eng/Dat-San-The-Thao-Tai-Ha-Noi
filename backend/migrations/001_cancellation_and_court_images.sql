-- Bổ sung ảnh và hạn hủy trên sports_court_booking đã cài từ csdl.sql.
USE `sports_court_booking`;

SET @schema_change = IF(EXISTS (
  SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'FACILITIES' AND COLUMN_NAME = 'image_url'
), 'DO 0', 'ALTER TABLE `FACILITIES` ADD COLUMN `image_url` VARCHAR(500) NULL CONSTRAINT `chk_facilities_image_url` CHECK (`image_url` IS NULL OR CHAR_LENGTH(TRIM(`image_url`)) > 0)');
PREPARE schema_change FROM @schema_change;
EXECUTE schema_change;
DEALLOCATE PREPARE schema_change;

SET @schema_change = IF(EXISTS (
  SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'FACILITIES' AND COLUMN_NAME = 'cancel_before_minutes'
), 'DO 0', 'ALTER TABLE `FACILITIES` ADD COLUMN `cancel_before_minutes` SMALLINT UNSIGNED NOT NULL DEFAULT 120 CONSTRAINT `chk_facilities_cancel_window` CHECK (`cancel_before_minutes` <= 10080)');
PREPARE schema_change FROM @schema_change;
EXECUTE schema_change;
DEALLOCATE PREPARE schema_change;

SET @schema_change = IF(EXISTS (
  SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'COURTS' AND COLUMN_NAME = 'image_url'
), 'DO 0', 'ALTER TABLE `COURTS` ADD COLUMN `image_url` VARCHAR(500) NULL CONSTRAINT `chk_courts_image_url` CHECK (`image_url` IS NULL OR CHAR_LENGTH(TRIM(`image_url`)) > 0)');
PREPARE schema_change FROM @schema_change;
EXECUTE schema_change;
DEALLOCATE PREPARE schema_change;

DELIMITER $$
CREATE TRIGGER IF NOT EXISTS `trg_bookings_before_cancel_window`
BEFORE UPDATE ON `BOOKINGS`
FOR EACH ROW FOLLOWS `trg_bookings_before_update_guard`
BEGIN
  IF NEW.`status` = 'Cancelled' AND OLD.`status` <> 'Cancelled'
     AND EXISTS (
       SELECT 1 FROM `FACILITIES` f
       WHERE f.`facility_id` = OLD.`facility_id`
         AND fn_now_vn() > DATE_SUB(OLD.`start_time`, INTERVAL f.`cancel_before_minutes` MINUTE)
         AND NOT EXISTS (
           SELECT 1 FROM `USERS` u
           WHERE u.`user_id` = @app_user_id
             AND u.`status` = 'Active' AND u.`deleted_at` IS NULL
             AND (u.`role` IN ('ADMIN', 'Staff')
                  OR (u.`role` = 'OWNER' AND u.`user_id` = f.`owner_id`))
         )
     ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CANCEL_WINDOW_CLOSED: Đã quá hạn hủy đơn do chủ sân quy định.';
  END IF;
END$$
DELIMITER ;
