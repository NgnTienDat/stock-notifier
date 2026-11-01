# StockNotifier — 3-Day Implementation Plan

**Đích đến:** MVP chạy **local** qua Shopify CLI tunnel, cài vào một Development Store, có webhook và Telegram thật. **Không deploy production, không quay demo video bắt buộc, không mở rộng scope.** P0 phải xong trước P1.

## Ngày 1 — Foundation + Inventory Sync

**Làm:**

1. Kiểm tra và tái sử dụng scaffold hiện tại trong `stock-notifier-app/` theo [official React Router template](https://github.com/Shopify/shopify-app-template-react-router); kiểm tra Node.js/TypeScript/version tương thích, không tạo lại project.
2. Cấu hình Shopify Dev Store + `shopify app dev`; xác nhận app mở trong Shopify Admin qua HTTPS tunnel.
3. Chuyển Prisma/session storage sang PostgreSQL; migration đầu tiên.
4. Cài schema nghiệp vụ với `InventoryLevel.variants Json`, `isCurrent` và unique theo item; pin runtime/codegen/webhooks **`2026-07`**, xác minh scopes GraphQL cần thiết.
5. Làm Settings chọn một location + Full Sync: scan đủ items/variants qua pagination, chỉ commit snapshots/`isCurrent`/`lastSyncedAt` sau khi scan thành công toàn bộ; giữ lịch sử và không ghi một phần khi lỗi. Initial sync tạo baseline không phát alert.

**Gate D1:** Embedded app xác thực được, lưu session/selected location, sync thật vào DB; một item có nhiều variants vẫn chỉ có một snapshot; sync lặp không trùng; scan lỗi không ghi một phần; item không còn hợp lệ được đánh dấu `isCurrent = false` sau scan thành công. Runtime/codegen/webhooks cùng `2026-07`.

## Ngày 2 — Webhook + Alert + Telegram

**Làm:**

1. Đăng ký `inventory_levels/update`, `inventory_levels/connect`, `inventory_levels/disconnect` version `2026-07`; thử delivery thật từ Shopify.
2. Xác thực HMAC theo template; lọc shop/location; unique delivery ID; chặn stale updates.
3. Dùng transaction cho inventory update và state transition; bảo vệ một active alert/item dù có nhiều variants. Hoàn thiện transitions của Full Sync/threshold và đổi location: resolve alerts cũ, reset `lastSyncedAt`, baseline mới không gửi Telegram.
4. Gửi Telegram sau commit; lưu `SENT/FAILED`; làm `Send Test Notification`.
5. Viết unit tests cho threshold, transition, dedup; integration test cho webhook duplicate/stale, full sync lỗi/race, nhiều variants/item và đổi location rồi quay lại.

**Gate D2:** Chuyển `NORMAL → LOW_STOCK` gửi một thông báo thật/item; cùng đợt low-stock không gửi trùng; restock resolve; giảm tiếp tạo alert mới. Đổi location resolve alerts cũ, reset mốc sync và baseline mới không tạo alert/gửi Telegram; lịch sử còn nguyên.

## Ngày 3 — UI + End-to-End + Cleanup

**Làm:**

1. Dashboard: KPI/table tính theo Inventory Item, hiển thị metadata nhiều variants từ JSON; chỉ lấy `isCurrent = true` tại selected location; status/filter, last sync.
2. Settings: threshold validation, location, Chat ID, Sync, test Telegram.
3. Nếu còn thời gian: Alert History (P1).
4. Kiểm thử toàn bộ flow trên Dev Store; sửa lỗi P0; hoàn thiện `.env.example`, README và lệnh setup/run/test.

**Gate D3:** Toàn bộ checklist P0 tại [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md) pass; `typecheck`, tests và build chạy thành công; README chỉ rõ giới hạn local/tunnel/reliability.

## Thứ tự ưu tiên khi thiếu thời gian

1. **Không cắt:** Shopify authentication, một location, sync, webhook verified, state transition, Telegram, một màn hình xem tồn kho, Settings và smoke tests.
2. **Có thể tối giản:** Dashboard styling; alert history P1; bộ lọc nâng cao.
3. **Bỏ:** production hosting, CI/CD phức tạp, container orchestration, background queues, additional platforms, AI, video demo.

## Quy tắc giao việc cho Codex

Tuân thủ `AGENTS.md` hiện có ở root (không cần thêm hệ thống `.agents/` cho dự án 3 ngày), với các nguyên tắc:

- Theo phạm vi [PRD.md](PRD.md) và source conventions của Shopify template; TypeScript strict.
- Giữ nghiệp vụ trong service; route chỉ xác thực, validate và gọi service; Prisma/PostgreSQL.
- Xác minh Shopify API scopes/fields/webhooks từ docs chính thức của **`2026-07`** trước khi viết integration.
- Không thêm infrastructure/package nếu không thật sự cần; không tự mở rộng P1/P2.
- Mỗi milestone báo file đã sửa, cách chạy, kết quả lệnh test và phần còn thiếu; không tự đánh dấu pass khi chưa thử.

**Prompt triển khai đề xuất:**

> Đọc `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/ACCEPTANCE_CRITERIA.md` và `docs/IMPLEMENTATION_PLAN.md`. Triển khai **chỉ Ngày 1** theo scope P0, tuân thủ official Shopify React Router template. Trước khi code, xác minh API version/scopes và ghi ngắn gọn các giả định. Sau khi code, chạy kiểm chứng, báo gate D1 PASS/FAIL và blocker thật sự. Không bắt đầu Ngày 2 khi tôi chưa yêu cầu.

Sau khi hoàn thành từng ngày, đổi `Ngày 1` thành `Ngày 2`, rồi `Ngày 3`; không cần làm lại planning tổng thể.
