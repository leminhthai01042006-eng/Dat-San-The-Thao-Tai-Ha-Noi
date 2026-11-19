## Chạy backend trên Windows

1. Chuẩn bị Node.js và MySQL 8.4.
2. Đăng nhập MySQL và nhập file `csdl.sql` vào cơ sở dữ liệu mới.
   File này tạo cơ sở dữ liệu `sports_court_booking`.
3. Tạo tài khoản MySQL cho ứng dụng và cấp quyền theo mục Quyền MySQL bên dưới.
4. Tạo file `.env` trong thư mục `backend` với các biến sau.

   ```dotenv
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=courtpulse_app
   DB_PASSWORD=THAY_BANG_MAT_KHAU_MYSQL_CUA_UNG_DUNG
   DB_NAME=sports_court_booking
   SESSION_SECRET=THAY_BANG_KHOA_KY_PHIEN_RIENG
   ```

   Thay các giá trị mẫu bằng thông tin trên máy của bạn. Giữ file `.env` cục bộ.

5. Từ thư mục gốc của repo, chạy lần lượt trong PowerShell.

   ```powershell
   Set-Location backend
   npm.cmd ci
   npm.cmd start
   ```

   `npm.cmd ci` cài đúng các phiên bản thư viện đã khóa trong `package-lock.json`.
   `npm.cmd start` nạp `.env` và khởi động Express trên cổng `3000`.

6. Mở `http://localhost:3000/api/health`. Backend kết nối MySQL thành công khi
   API trả `{"status":"ok","database":"connected"}`.

   ### Quyền MySQL

Sau khi nhập `csdl.sql`, đăng nhập MySQL bằng tài khoản quản trị để tạo
tài khoản ứng dụng. Thay `MAT_KHAU_RIENG_CUA_BACKEND` bằng mật khẩu riêng
và dùng cùng mật khẩu đó cho `DB_PASSWORD` trong file `.env`.

```sql
CREATE USER 'courtpulse_app'@'localhost'
IDENTIFIED BY 'MAT_KHAU_RIENG_CUA_BACKEND';

GRANT SELECT ON sports_court_booking.*
TO 'courtpulse_app'@'localhost';

GRANT INSERT (full_name, email, phone, password_hash),
      UPDATE (status)
ON sports_court_booking.USERS
TO 'courtpulse_app'@'localhost';

GRANT INSERT (venue_code, facility_name, address, district, city, hotline, owner_id),
      UPDATE (facility_name, address, district, city, hotline,
              open_time, close_time, is_overnight)
ON sports_court_booking.FACILITIES
TO 'courtpulse_app'@'localhost';

GRANT INSERT (facility_id, sport_type, court_code, court_name,
              price_per_hour, requires_approval),
      UPDATE (court_name, price_per_hour, requires_approval, status)
ON sports_court_booking.COURTS
TO 'courtpulse_app'@'localhost';

GRANT INSERT (booking_code, facility_id, court_id, user_id,
              start_time, end_time, court_rental_amount),
      UPDATE (status, approval_status, cancel_reason)
ON sports_court_booking.BOOKINGS
TO 'courtpulse_app'@'localhost';

GRANT EXECUTE ON PROCEDURE sports_court_booking.sp_lock_court_days
TO 'courtpulse_app'@'localhost';

GRANT EXECUTE ON FUNCTION sports_court_booking.fn_now_vn
TO 'courtpulse_app'@'localhost';
```

Quyền ghi được giới hạn theo các cột mà API sử dụng. Backend gọi
`sp_lock_court_days` khi chủ sân xác nhận đơn và gọi `fn_now_vn`
khi cập nhật các đơn quá hạn giữ chỗ.

## API chính

| Chức năng                                                       | API                                                                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Đăng ký, đăng nhập, đăng xuất                                   | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`                                                                               |
| Xem tài khoản đang đăng nhập                                    | `GET /api/auth/me`                                                                                                                                       |
| Xem cụm sân, sân con và lịch theo ngày                          | `GET /api/facilities`, `GET /api/facilities/:facilityId/courts`, `GET /api/facilities/:facilityId/courts/:courtId/availability?date=YYYY-MM-DD`          |
| Người chơi đặt, xem và hủy đơn                                  | `POST /api/bookings`, `GET /api/bookings/me`, `POST /api/bookings/:bookingId/cancel`                                                                     |
| Chủ sân tạo và sửa cụm sân                                      | `POST /api/facilities`, `PUT /api/facilities/:facilityId`                                                                                                |
| Chủ sân thêm sân, sửa thông tin và đổi trạng thái sân           | `POST /api/facilities/:facilityId/courts`, `PUT /api/facilities/:facilityId/courts/:courtId`, `PATCH /api/facilities/:facilityId/courts/:courtId/status` |
| Chủ sân xem và xử lý đơn chờ duyệt                              | `GET /api/bookings/pending-approval`, `POST /api/bookings/:bookingId/decision`                                                                           |
| Quản trị viên xem, khóa hoặc mở khóa tài khoản và duyệt chủ sân | `GET /api/admin/users`, `PATCH /api/admin/users/:userId/status`, `PATCH /api/admin/owners/:userId/approve`                                               |

API cần đăng nhập sử dụng cookie phiên do API đăng nhập trả về.
Trong bản demo, tài khoản quản trị và tài khoản chủ sân chờ duyệt được tạo bằng SQL.
Tài khoản chủ sân chờ duyệt có trạng thái `Inactive`.

## Kết quả kiểm thử backend

- **Luồng đầy đủ.** Quản trị viên duyệt chủ sân. Chủ sân đăng nhập, tạo cụm sân
  và sân con. Người chơi xem lịch và đặt sân. Sau khi chủ sân xác nhận,
  lịch sử của người chơi hiển thị `approval_status = Confirmed`.
- **Đặt đồng thời.** Hai người chơi đặt cùng sân, cùng khung giờ. Một yêu cầu
  trả `201`, yêu cầu còn lại trả `409`. Truy vấn MySQL xác nhận chỉ có một đơn
  được tạo cho ca thử.
- **Phân quyền.** Chủ sân bị từ chối khi sửa sân của chủ khác. Người chơi bị
  từ chối khi hủy đơn của người khác hoặc gọi API quản trị.
- **Hết hạn giữ chỗ.** Backend tự chuyển đơn `Pending` đã quá hạn sang `Expired`.
- **Bảo trì sân.** Sân ở trạng thái `Maintenance` từ chối yêu cầu đặt mới.
