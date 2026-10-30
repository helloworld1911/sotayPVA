# Sổ Tay Ôn Tập

Web ôn tập gồm ghi chú, ngân hàng đề trắc nghiệm và thẻ từ vựng. Chạy trên **Cloudflare Workers** với cơ sở dữ liệu **D1**.

## Tài khoản

- Ai mở web cũng thấy màn hình **Đăng nhập / Đăng ký**.
- Mỗi tài khoản có ghi chú, bộ đề, bộ từ và lịch sử làm bài **riêng**.
- **Tài khoản đăng ký đầu tiên** sẽ nhận toàn bộ dữ liệu có sẵn (ghi chú Scrum, bộ đề, bộ từ PMP).
- Mật khẩu được băm bằng PBKDF2 trước khi lưu. Phiên đăng nhập kéo dài 30 ngày, đổi mật khẩu thì các phiên cũ bị đăng xuất.

## Cấu hình trên Cloudflare (Settings → Variables and Secrets)

| Tên | Loại | Bắt buộc | Tác dụng |
|---|---|---|---|
| `INVITE_CODE` | Secret | Không | Nếu đặt, người đăng ký phải nhập đúng mã mời này. Nên đặt để người lạ không tự tạo tài khoản. |
| `ANTHROPIC_API_KEY` | Secret | Không | Bật các nút "Nhờ Claude". Phí API tính riêng. |
| `SESSION_SECRET` | Secret | Không | Khoá ký phiên đăng nhập. Không đặt thì web tự tạo và lưu trong database. |

Binding database `DB` đã khai báo trong `wrangler.toml`. Bảng dữ liệu được tạo tự động ở lần chạy đầu.

## Cập nhật web

Sửa file trên GitHub (hoặc đẩy code mới) → Cloudflare tự build và deploy lại sau 1–2 phút.

## Cấu trúc

```
public/index.html   giao diện (đã gắn sẵn adapter.js)
adapter.js          màn hình đăng nhập/đăng ký và kết nối API (bản gốc)
src/worker.js       API: tài khoản, dữ liệu theo từng người, Claude
src/seed.js         dữ liệu ban đầu cho tài khoản đầu tiên
wrangler.toml       cấu hình Cloudflare
```

## Sao lưu

Vào Cloudflare → D1 → so-tay-db → **Time Travel** để khôi phục về thời điểm trước (trong 30 ngày). Hoặc chạy `npm run db:backup` nếu có cài Node.js.
