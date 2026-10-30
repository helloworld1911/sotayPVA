# Sổ Tay Ôn Tập: tự đưa lên mạng với Cloudflare

Web gồm 3 phần:

- **Trang web** (`public/index.html`): giao diện ghi chú, kiểm tra, từ vựng.
- **API** (`src/worker.js`): chạy trên Cloudflare Workers, kiểm tra mật khẩu, đọc và ghi dữ liệu.
- **Cơ sở dữ liệu D1** (`schema.sql`): lưu toàn bộ ghi chú, bộ đề, lượt làm bài và bộ từ.

Dữ liệu bạn đang có trên bản claude.ai đã được xuất sẵn vào `seed.sql`.

---

## Bước 1. Chuẩn bị

- Cài **Node.js 18 trở lên** (kiểm tra bằng lệnh `node -v`).
- Dùng tài khoản **Cloudflare** của web tiếng Anh là được.
- Giải nén thư mục này, mở Terminal tại thư mục `so-tay-on-tap-web`.

## Bước 2. Cài công cụ

```bash
npm install
```

## Bước 3. Đăng nhập Cloudflare

```bash
npx wrangler login
```

Trình duyệt sẽ mở ra, bấm **Allow**.

## Bước 4. Tạo cơ sở dữ liệu

```bash
npx wrangler d1 create so-tay-db
```

Lệnh này in ra một đoạn có dòng `database_id = "xxxxxxxx-..."`. Mở `wrangler.toml` và thay `DIEN_DATABASE_ID_VAO_DAY` bằng mã đó.

## Bước 5. Tạo bảng và nạp dữ liệu hiện có

```bash
npm run db:schema
npm run db:seed
```

## Bước 6. Đặt mật khẩu đăng nhập web

```bash
npx wrangler secret put APP_PASSWORD
```

Gõ mật khẩu bạn muốn rồi nhấn Enter. Chỉ ai biết mật khẩu này mới xem và sửa được sổ tay.

## Bước 7 (tuỳ chọn). Bật các nút "Nhờ Claude"

Các nút soạn đề, giải thích, điền nghĩa từ vựng cần **khoá API của Anthropic**.

1. Tạo khoá tại https://console.anthropic.com.
2. Chạy lệnh:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Phí API tính riêng theo lượt dùng, không nằm trong gói Claude Pro. Nếu bỏ qua bước này, web vẫn chạy bình thường và các nút Claude sẽ tự ẩn.

## Bước 8. Đưa lên mạng

```bash
npm run deploy
```

Xong sẽ có địa chỉ dạng `https://so-tay-on-tap.<tên-bạn>.workers.dev`. Mở địa chỉ đó, nhập mật khẩu ở Bước 6 là dùng được.

---

## Tự động cập nhật khi đẩy code lên GitHub (giống web tiếng Anh)

1. Tạo repo mới trên GitHub, ví dụ `so-tay-on-tap`, rồi đẩy thư mục này lên:

   ```bash
   git init && git add . && git commit -m "Sổ Tay Ôn Tập"
   git branch -M main
   git remote add origin https://github.com/<tên-bạn>/so-tay-on-tap.git
   git push -u origin main
   ```

2. Vào Cloudflare Dashboard → **Workers & Pages** → chọn **so-tay-on-tap** → **Settings** → **Builds** → **Connect** và chọn repo vừa tạo.
3. Từ giờ, mỗi lần `git push` Cloudflare sẽ tự deploy. Mật khẩu và khoá API đặt ở Bước 6–7 vẫn được giữ nguyên.

## Chạy thử trên máy trước khi deploy

```bash
cp .dev.vars.example .dev.vars   # sửa mật khẩu thử trong file này
npm run db:local                 # tạo bảng và nạp dữ liệu vào DB trên máy
npm run dev                      # mở http://localhost:8787
```

## Sao lưu dữ liệu

```bash
npm run db:backup
```

Lệnh này tạo file `backup.sql` chứa toàn bộ dữ liệu. Nên chạy mỗi tuần một lần.

## Chi phí (gói miễn phí Cloudflare)

D1 miễn phí:
- 5 triệu lượt đọc mỗi ngày
- 100.000 lượt ghi mỗi ngày
- 5 GB dung lượng

Dùng cá nhân sẽ không chạm tới các giới hạn này. Workers cũng có gói miễn phí theo số request mỗi ngày.

## Đổi mật khẩu

Chạy lại `npx wrangler secret put APP_PASSWORD`. Mọi thiết bị đang đăng nhập sẽ phải đăng nhập lại.

## Cấu trúc thư mục

```
public/index.html   giao diện (đã gắn sẵn phần kết nối API)
adapter.js          bản gốc của phần kết nối API (đã nhúng vào index.html)
src/worker.js       API: đăng nhập, dữ liệu, Claude
schema.sql          cấu trúc bảng D1
seed.sql            dữ liệu hiện có xuất từ claude.ai
wrangler.toml       cấu hình Cloudflare
```
