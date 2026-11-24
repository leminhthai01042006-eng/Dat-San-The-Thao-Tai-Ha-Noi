# CourtPulse

CourtPulse hỗ trợ tìm và đặt sân thể thao tại Hà Nội. Có ba khu vực theo vai trò: người chơi xem lịch của mình, chủ sân quản lý sân và duyệt đơn, quản trị viên quản lý tài khoản.

## Chạy website trên Windows

1. Khởi động MySQL và backend theo phần bên dưới. Nếu backend đang chạy từ phiên trước, dừng bằng `Ctrl+C` rồi khởi động lại để nạp các API mới.
2. Mở terminal PowerShell thứ hai trong thư mục gốc của repo.

   ```powershell
   Set-Location frontend
   npm.cmd ci
   npm.cmd run dev
   ```

3. Mở [CourtPulse trên cổng 5173](http://localhost:5173), hoặc dùng địa chỉ do Vite in ra. Vite chuyển các yêu cầu `/api` sang backend trên cổng `3000` và dùng chung địa chỉ cho cookie phiên. Nếu đổi cổng backend bằng biến môi trường `PORT`, đặt `COURTPULSE_API_TARGET` ở terminal frontend theo địa chỉ backend tương ứng.

Trong thư mục `frontend`, dùng `npm.cmd run lint` để kiểm tra mã và `npm.cmd run build` để tạo bản dựng.

## Hạng mục giao diện cho báo cáo

- **Trang chủ.** Ảnh sân minh họa riêng và số liệu từ danh bạ hiện có. Bộ lọc khu vực, môn, ngày giờ và giá tối đa nằm ở trang tìm sân trống. Số liệu xuất hiện khi cuộn nhờ [Count Up của React Bits](https://reactbits.dev/text-animations/count-up), kèm [giấy phép](frontend/REACT-BITS-LICENSE.md).
- **Người chơi.** Đăng ký, đăng nhập, xem khung giờ đã có lịch, giữ chỗ và xem hoặc hủy lượt đặt theo điều kiện của backend. Lịch hiển thị riêng tình trạng giữ chỗ và xác nhận của chủ sân.
- **Chủ sân.** Thêm và sửa cụm sân, thêm và sửa sân con, đổi trạng thái sân, duyệt hoặc từ chối lượt đặt. Quản trị viên xem tài khoản, duyệt chủ sân và khóa hoặc mở khóa tài khoản.
- **Thống kê.** Các thẻ số và biểu đồ thanh hiển thị số lượng theo trạng thái. Lịch của người chơi và danh sách chờ duyệt tối đa 50 bản ghi. Danh sách quản trị tối đa 100 tài khoản. Trang doanh thu tổng hợp theo kỳ đã chọn.
- **API bổ sung.** `GET /api/facilities/mine` đọc cụm sân thuộc chủ sân đang đăng nhập. `GET /api/facilities/sports` đọc các môn đang hoạt động từ bảng danh mục `sports` có sẵn. `GET /api/bookings/me` trả thêm `court_id` và `hold_expires_at` để đếm số sân và hiển thị đúng thời hạn giữ chỗ.
- **Mô hình dữ liệu.** Giữ nguyên bốn bảng lõi `USERS`, `FACILITIES`, `COURTS`, `BOOKINGS` và các quan hệ 1–N. Đối soát chuyển khoản dùng bảng `payments` và các trigger hiện có.
- **Tham khảo thiết kế.** Bố cục trang chủ dùng ảnh nổi bật, chữ lớn và tương phản mạnh theo hướng của [OpenAI Codex](https://openai.com/vi-VN/codex/) và [NVIDIA](https://www.nvidia.com/en-us/). Trình tự chọn sân, đặt lịch và duyệt đơn tham khảo [hướng dẫn ALOBO](https://wiki.alobo.vn/article/huong-dan-dat-lich-online-va-duyet-don/).

### Bản giao diện nhiều trang

| Trang | Đường dẫn |
| --- | --- |
| Trang chủ và phần giới thiệu | `/`, `/gioi-thieu` |
| Chọn môn, danh bạ theo môn và chi tiết địa điểm | `/tim-san`, `/tim-san/:mon`, `/san/:diaDiem` |
| Tìm giờ trống và đặt qua CourtPulse | `/san-trong`, `/san-trong/:mon`, `/dat-san/:facilityId/:courtId` |
| Trang hoàn tất và lịch của người chơi | `/hoan-tat/:bookingId`, `/lich-cua-toi` |
| Quản lý và tổng quan doanh thu | `/quan-ly`, `/tong-quan` |

- Danh bạ có 36 mục tham khảo cho bóng bàn, cầu lông, bóng chuyền và pickleball. Dữ liệu danh bạ lưu trong frontend, có nguồn theo địa điểm, giá tham khảo khi tìm được và liên kết chỉ đường Google Maps. Ảnh dùng để minh họa từng môn. Địa điểm nhận đặt qua CourtPulse được quản lý riêng bằng dữ liệu sân thật trong MySQL.
- Luồng đặt sân gồm chọn giờ, kiểm tra đơn, thanh toán và hoàn tất. Khách có thể chọn chuyển khoản tại cụm sân đã thiết lập tài khoản nhận. Đơn được ghi nhận đã thanh toán sau khi chủ sân đối chiếu sao kê.
- `GET /api/bookings/:bookingId/receipt` đọc chi tiết đơn của người chơi đang đăng nhập. `GET /api/bookings/revenue?days=7|30|90` đọc tổng hợp từ `payments` và `BOOKINGS`. Chủ sân chỉ xem số liệu cụm sân mình sở hữu. Quản trị viên xem toàn hệ thống. Kỳ thu và hoàn dựa trên ngày giao dịch, số lượt đặt dựa trên ngày chơi.
- Các trang bổ sung dùng các bảng và quan hệ hiện có. Khi muốn chủ sân tạo sân con cho đủ bốn môn, tài khoản quản trị MySQL có thể bổ sung các mã còn thiếu vào bảng danh mục `sports`.

  ```sql
  INSERT IGNORE INTO sports_court_booking.sports (sport_code, name)
  VALUES ('TABLE_TENNIS', 'Bóng bàn'), ('BADMINTON', 'Cầu lông'),
         ('VOLLEYBALL', 'Bóng chuyền'), ('PICKLEBALL', 'Pickleball');
  ```

### Trạng thái sân theo khung giờ

- Sau khi tìm khung giờ, trang hiển thị số sân còn trống, số sân đã có lịch và tổng lượt giữ chỗ hoặc đã đặt. Sân được tính theo giờ mở cửa và các bộ lọc đang chọn. Mỗi sân có lịch được đếm một lần, kể cả khi một khung giờ dài giao với nhiều lượt đặt trên sân đó.
- Số liệu tự tải lại khoảng 10 giây một lần và khi quay lại cửa sổ. Đơn đã hủy hoặc hết hạn giữ chỗ được loại ngay khi truy vấn. Danh bạ tham khảo chỉ có số chỗ cho sân thực sự nhận lịch qua CourtPulse.
- `GET /api/facilities/search?include_status=1` trả cả sân đã có lịch, kèm `booking_count`. Gọi API không có tham số này vẫn trả danh sách sân trống.

### Lịch và thanh toán trên bốn trang danh bạ

- Cả 36 thẻ của bốn môn dùng chung khung giờ đang chọn. Địa điểm đã liên kết hiển thị số sân trống, số sân có lịch, số lượt đặt và trạng thái hỗ trợ chuyển khoản. Trang chi tiết liệt kê sân con còn trống để vào bước đặt sân của CourtPulse. Danh bạ giữ nguyên khung giờ khi đổi môn hoặc mở chi tiết.
- Địa điểm dùng hệ thống bên ngoài dẫn tới kênh đặt sân công khai hoặc trang liên hệ của sân. CourtPulse chỉ hiển thị số chỗ hiện tại khi có lịch được đăng ký trực tiếp trên hệ thống. Các đường dẫn bổ sung được đối chiếu với [ALOBO](https://www.alobo.vn/san-pickleball-o-ha-noi-dang-de-trai-nghiem/), [LOOL](https://lool.vn/san/cau-long-ha-noi/) và [MPA Pickleball](https://mpapickleball.com/lien-he).
- Sau khi xác minh chủ sân đã đăng ký đúng cụm sân và môn trong MySQL, người vận hành khai báo liên kết trong `backend/.env`. Khóa là phần cuối đường dẫn `/san/...`. Giá trị là `FACILITIES.facility_id` tương ứng. Khởi động lại backend sau khi cấu hình.

  ```dotenv
  COURTPULSE_DIRECTORY_LINKS='{"pickleball-vu-duc-than":"ID_CUM_SAN_DA_XAC_MINH","cau-long-kim-giang":"ID_CUM_SAN_DA_XAC_MINH"}'
  ```

  API đọc dùng `GET /api/facilities/search?directory=1&sport_type=...` với cùng tham số thời gian. Chuyển khoản tiếp tục dùng tài khoản thụ hưởng của chủ sân và bước đối soát hiện có. Các liên kết nằm trong cấu hình và dùng các bảng hiện có.

### Bật nhận chuyển khoản

1. Xác minh tài khoản nhận tiền với chủ sân, rồi đặt cấu hình trong `backend/.env`. Khóa ngoài cùng là `USERS.user_id` của chủ sân. Điền các giá trị thực thay cho mẫu và khởi động lại backend.

   ```dotenv
   COURTPULSE_BANK_ACCOUNTS='{"ID_CHU_SAN":{"bank":"TEN_NGAN_HANG","accountNumber":"SO_TAI_KHOAN","accountName":"TEN_CHU_TAI_KHOAN"}}'
   ```

2. Tài khoản quản trị MySQL cấp quyền ghi sổ thanh toán cho tài khoản ứng dụng. Backend chỉ hiện chuyển khoản khi có cấu hình hợp lệ và có quyền ghi.

   ```sql
   GRANT INSERT (booking_id, processed_by, payment_type, payment_method, amount,
                 transaction_ref, payment_status)
   ON sports_court_booking.payments
   TO 'courtpulse_app'@'localhost';
   ```

3. Người chơi chọn chuyển khoản và giữ chỗ. Khi đơn được duyệt và còn hiệu lực, chi tiết đơn hiện tên ngân hàng, tài khoản nhận, số tiền còn phải trả, nội dung `CP<mã số đơn>` và hạn đối soát. Người chơi chuyển tiền trên ứng dụng ngân hàng.
4. Chủ sân vào **Quản lý → Đối soát chuyển khoản**. Đối chiếu tài khoản nhận, nội dung, số tiền và mã giao dịch trên sao kê trước khi xác nhận. Backend ghi một dòng vào `payments` và chuyển đơn sang `Fully_Paid` trong cùng giao dịch MySQL. Nếu đơn đã hết hiệu lực, chủ sân cần xử lý khoản đã nhận với người chuyển.

API hỗ trợ gồm `GET /api/bookings/transfer-options/:facilityId`, `GET /api/bookings/transfers-to-reconcile` và `POST /api/bookings/:bookingId/confirm-transfer`. Đây là luồng đối soát thủ công. Doanh thu sử dụng số tiền đã ghi nhận.

### Kiểm thử giao diện

- Lint và build Vite chạy thành công. Kiểm tra trên Edge ở các chiều rộng 1440, 390 và 320 px.
- Đã kiểm tra bốn trang theo môn, lọc địa điểm, liên kết Google Maps, hiệu ứng số khi cuộn, tìm giờ trống, đăng nhập và các bước đặt sân.
- MySQL cục bộ phục vụ tra cứu lịch, đọc lại chi tiết đơn và báo cáo doanh thu cho chủ sân, quản trị viên. Đã kiểm tra người chơi bị từ chối khi gọi báo cáo hoặc đọc đơn của người khác. Lệnh gửi đơn được mô phỏng phản hồi khi kiểm thử giao diện để giữ dữ liệu demo hiện có.
- Kiểm thử đầu cuối bằng Edge và MySQL tạm xác nhận đặt thêm một lượt làm tăng số đếm, hủy và hết hạn giải phóng sân, người không có quyền bị từ chối khi đối soát, số tiền sai bị từ chối, cùng mã giao dịch chỉ ghi một lần và số tiền đã nhận lên báo cáo doanh thu. Các giao dịch kiểm thử dùng tài khoản giả lập trong cơ sở dữ liệu tạm.
- Với danh bạ, đã kiểm tra dữ liệu liên kết cho cả bốn môn trên MySQL tạm, giữ khung giờ tới trang đặt sân, hiển thị hướng dẫn chuyển khoản khi đủ điều kiện và tự cập nhật số chỗ sau khi hủy đơn. Địa điểm ngoài hệ thống mở đúng kênh bên ngoài và không có số chỗ do CourtPulse tự tính.

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

GRANT INSERT (venue_code, facility_name, address, district, city, hotline, owner_id,
              image_url, cancel_before_minutes),
      UPDATE (facility_name, address, district, city, hotline,
              open_time, close_time, is_overnight, image_url, cancel_before_minutes)
ON sports_court_booking.FACILITIES
TO 'courtpulse_app'@'localhost';

GRANT INSERT (facility_id, sport_type, court_code, court_name,
              price_per_hour, requires_approval, image_url),
      UPDATE (court_name, price_per_hour, requires_approval, status, image_url)
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

### Nâng cấp database hiện có

Với database `sports_court_booking` đã cài từ `csdl.sql`, dùng tài khoản quản trị MySQL để chạy migration dưới đây từ thư mục gốc của repo.

```sql
SOURCE backend/migrations/001_cancellation_and_court_images.sql;
```

Nếu tài khoản backend đã được cấp quyền theo cột, cấp thêm quyền ghi cho các cột mới.
Thay `'courtpulse_app'@'localhost'` bằng tài khoản ứng dụng thực tế nếu dùng tên khác.

```sql
GRANT INSERT (image_url, cancel_before_minutes), UPDATE (image_url, cancel_before_minutes)
ON sports_court_booking.FACILITIES TO 'courtpulse_app'@'localhost';

GRANT INSERT (image_url), UPDATE (image_url)
ON sports_court_booking.COURTS TO 'courtpulse_app'@'localhost';
```

### Hạn hủy và ảnh sân

- Chủ sân gửi `cancel_before_minutes` qua API tạo hoặc sửa cụm sân. Giá trị mặc định là 120 phút, khoảng cho phép từ 0 đến 10080. Giá trị 0 cho phép người chơi hủy đến trước giờ bắt đầu nếu đơn còn đủ điều kiện hủy. MySQL áp dụng cấu hình hiện tại của cụm sân khi hủy đơn. Chủ của cụm sân đó, quản trị viên và nhân viên được miễn hạn này khi xử lý đơn theo quyền hiện có.
- `POST /api/bookings/:bookingId/cancel` trả HTTP 409 với mã `CANCEL_WINDOW_CLOSED` nếu khách hủy sau hạn.
- API tạo và sửa cụm sân hoặc sân con nhận `image_url` là URL HTTP(S) tối đa 500 ký tự. Khi sửa, bỏ qua trường này để giữ ảnh hiện tại hoặc gửi `null` để xóa URL. API danh sách cụm sân, danh sách sân và tìm sân trả URL đã lưu.

Đã kiểm thử trên MySQL 8.4 tạm. Schema cài mới thành công, migration chạy được trên schema cũ và chạy lại được. Kiểm thử API xác nhận khách hủy trước hạn thành công, hủy trễ nhận HTTP 409 và đơn vẫn chờ xử lý. Chủ sân vẫn từ chối được đơn chờ duyệt. Cấu hình 0 phút cho phép khách hủy trước giờ bắt đầu. API lưu, đọc, giữ và xóa URL ảnh, từ chối URL sai loại và từ chối người chơi sửa cấu hình cụm sân.

## API chính

| Chức năng                                                       | API                                                                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Đăng ký, đăng nhập, đăng xuất                                   | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`                                                                               |
| Xem tài khoản đang đăng nhập                                    | `GET /api/auth/me`                                                                                                                                       |
| Xem cụm sân, sân con và lịch theo ngày                          | `GET /api/facilities`, `GET /api/facilities/:facilityId/courts`, `GET /api/facilities/:facilityId/courts/:courtId/availability?date=YYYY-MM-DD`          |
| Tìm sân trống theo khung giờ, phường, môn và giá tối đa | `GET /api/facilities/search` |
| Người chơi đặt, xem và hủy đơn                                  | `POST /api/bookings`, `GET /api/bookings/me`, `POST /api/bookings/:bookingId/cancel`                                                                     |
| Chủ sân tạo và sửa cụm sân                                      | `POST /api/facilities`, `PUT /api/facilities/:facilityId`                                                                                                |
| Chủ sân thêm sân, sửa thông tin và đổi trạng thái sân           | `POST /api/facilities/:facilityId/courts`, `PUT /api/facilities/:facilityId/courts/:courtId`, `PATCH /api/facilities/:facilityId/courts/:courtId/status` |
| Chủ sân xem và xử lý đơn chờ duyệt                              | `GET /api/bookings/pending-approval`, `POST /api/bookings/:bookingId/decision`                                                                           |
| Quản trị viên xem, khóa hoặc mở khóa tài khoản và duyệt chủ sân | `GET /api/admin/users`, `PATCH /api/admin/users/:userId/status`, `PATCH /api/admin/owners/:userId/approve`                                               |

API cần đăng nhập sử dụng cookie phiên do API đăng nhập trả về.
Trong bản demo, tài khoản quản trị và tài khoản chủ sân chờ duyệt được tạo bằng SQL.
Tài khoản chủ sân chờ duyệt có trạng thái `Inactive`.

### Tìm sân trống

`GET /api/facilities/search` nhận các tham số sau.

| Tham số | Ý nghĩa |
| --- | --- |
| `start_time`, `end_time` | Bắt buộc. Nhập giờ Việt Nam theo dạng `YYYY-MM-DD HH:mm`. Giờ bắt đầu phải ở tương lai và thời lượng phải từ 30 phút đến 12 giờ. |
| `district` | Tùy chọn. Tên phường được lưu trong `FACILITIES.district`. |
| `sport_type` | Tùy chọn. Mã môn thể thao, ví dụ `BADMINTON`. |
| `max_price` | Tùy chọn. Giá thuê tối đa mỗi giờ, tính bằng đồng và bao gồm sân có giá đúng mức tối đa. |

Backend chỉ trả sân đang nhận đặt, mở cửa trong toàn bộ khung giờ yêu cầu và
không có lượt đặt còn hiệu lực giao với khung giờ đó. Hai lượt đặt có giờ kết
thúc của lượt trước bằng giờ bắt đầu của lượt sau được phép nằm liền kề.
Nếu không có sân phù hợp, API trả `[]`. API tạo đơn kiểm tra lại lịch khi ghi.

Tính năng đọc từ `FACILITIES`, `COURTS` và `BOOKINGS` qua các quan hệ hiện có.

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
- **Tìm sân trống.** Khi lọc sân cầu lông ở `Phuong Mau`, sân giá 150.000 đồng/giờ
  xuất hiện ở mức tối đa 150.000 đồng/giờ và bị loại khi giảm mức tối đa xuống
  120.000 đồng/giờ. Lượt giữ chỗ 18:30–19:30 loại sân số `4` khỏi khung
  18:00–19:00, còn khung 18:00–18:30 vẫn trả về sân đó. Sau khi hủy đơn thử,
  truy vấn khung 18:00–19:00 trả về sân số `4` trở lại.
