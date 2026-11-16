
-- Tạo Database

CREATE DATABASE IF NOT EXISTS dat_san_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE dat_san_db;

-- NGƯỜI DÙNG: Người chơi, Chủ sân, Admin

CREATE TABLE USERS (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    phone VARCHAR(15),
    role ENUM('USER', 'OWNER', 'ADMIN') NOT NULL DEFAULT 'USER',
    status ENUM('ACTIVE', 'INACTIVE', 'PENDING') DEFAULT 'ACTIVE', 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- CỤM SÂN

CREATE TABLE FACILITIES (
    facility_id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NOT NULL,
    facility_name VARCHAR(255) NOT NULL,
    district VARCHAR(100) NOT NULL,
    address VARCHAR(255),
    FOREIGN KEY (owner_id) REFERENCES USERS(user_id) ON DELETE RESTRICT
);


-- SÂN

CREATE TABLE COURTS (
    court_id INT AUTO_INCREMENT PRIMARY KEY,
    facility_id INT NOT NULL,
    court_name VARCHAR(100) NOT NULL,
    sport_type VARCHAR(50) NOT NULL,
    price_per_hour DECIMAL(12, 2) NOT NULL,
    requires_approval BOOLEAN DEFAULT FALSE, 
    status ENUM('AVAILABLE', 'MAINTENANCE') DEFAULT 'AVAILABLE',
    FOREIGN KEY (facility_id) REFERENCES FACILITIES(facility_id) ON DELETE CASCADE
);


-- ĐẶT SÂN

CREATE TABLE BOOKINGS (
    booking_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    court_id INT NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    status ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'REJECTED') DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES USERS(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (court_id) REFERENCES COURTS(court_id) ON DELETE CASCADE,
    
    CONSTRAINT chk_time CHECK (end_time > start_time)
);

CREATE INDEX idx_court_time ON BOOKINGS (court_id, start_time, end_time);

DELIMITER //

-- Trigger kiểm tra khi THÊM mới đơn đặt sân
CREATE TRIGGER prevent_overlapping_booking_insert
BEFORE INSERT ON BOOKINGS
FOR EACH ROW
BEGIN
    DECLARE overlap_count INT;
    
    -- Nếu đơn được tạo ở trạng thái có hiệu lực
    IF NEW.status IN ('PENDING', 'CONFIRMED') THEN
        SELECT COUNT(*) INTO overlap_count
        FROM BOOKINGS
        WHERE court_id = NEW.court_id
          AND status IN ('PENDING', 'CONFIRMED')
          AND (NEW.start_time < end_time AND NEW.end_time > start_time);

        IF overlap_count > 0 THEN
            SIGNAL SQLSTATE '45000' 
            SET MESSAGE_TEXT = 'Lỗi: Khung giờ đặt sân bị trùng lặp với một đơn khác đang có hiệu lực.';
        END IF;
    END IF;
END;
//

-- Trigger kiểm tra khi CẬP NHẬT đơn đặt sân (Ví dụ: Duyệt đơn)
CREATE TRIGGER prevent_overlapping_booking_update
BEFORE UPDATE ON BOOKINGS
FOR EACH ROW
BEGIN
    DECLARE overlap_count INT;

    -- Nếu đơn được cập nhật sang trạng thái có hiệu lực
    IF NEW.status IN ('PENDING', 'CONFIRMED') THEN
        SELECT COUNT(*) INTO overlap_count
        FROM BOOKINGS
        WHERE court_id = NEW.court_id
          AND booking_id != NEW.booking_id
          AND status IN ('PENDING', 'CONFIRMED')
          AND (NEW.start_time < end_time AND NEW.end_time > start_time);

        IF overlap_count > 0 THEN
            SIGNAL SQLSTATE '45000' 
            SET MESSAGE_TEXT = 'Lỗi: Cập nhật thất bại. Khung giờ mới bị trùng lặp với một đơn khác.';
        END IF;
    END IF;
END;
//

DELIMITER ;
