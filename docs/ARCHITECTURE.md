# StockNotifier — Technical Architecture

Phạm vi: [PRD.md](PRD.md). Schema: [DATABASE.md](DATABASE.md). Đây là **modular monolith**, một app Node.js, một PostgreSQL; không triển khai worker, scheduler hay queue riêng cho MVP local.

## 1. Stack & conventions

- **Shopify official React Router app template**, TypeScript strict, React, App Bridge và UI components theo template thực tế; Node.js phiên bản tương thích template.
- **Shopify Admin GraphQL API `2026-07`**, webhook HTTPS, auth/session do Shopify package cung cấp. Runtime (`app/shopify.server.ts`), codegen (`.graphqlrc.ts`) dùng `ApiVersion.July26`; `[webhooks].api_version` trong `shopify.app.toml` là `2026-07`.
- **Prisma + PostgreSQL** cho session, settings, inventory, alerts và webhook deduplication.
- **Telegram Bot API** qua server, **Vitest** cho unit/integration tests.
- Dùng `shopify app dev` + tunnel HTTPS do Shopify CLI thiết lập để Shopify gửi webhook về app local. Không cần hosting production.

## 2. Sơ đồ hệ thống

```mermaid
flowchart TB
    M["Merchant - Shopify Admin"] --> UI["Embedded UI - React Router"]
    UI --> API["Shopify integration + Settings"]
    S["Shopify Admin GraphQL API"] <-->|"Locations, initial/manual sync"| API
    W["Shopify Webhooks"] -->|"inventory_levels/update"| INV["Inventory service"]
    API --> INV
    subgraph APP["StockNotifier - one Node.js process"]
        UI
        API
        INV --> ALERT["Alert engine"]
        ALERT --> NOTIFY["Telegram service"]
    end
    INV <--> DB[(PostgreSQL)]
    ALERT <--> DB
    API <--> DB
    NOTIFY --> T["Telegram Bot API"]
```

Webhook route độc lập, **không** nằm dưới embedded-app layout. Các routes xác thực shop trước khi truy cập dữ liệu. Services xử lý logic, route chỉ làm request/response. Giữ nguyên cấu trúc template; không bắt buộc tạo một cây thư mục phức tạp từ đầu.

### Cấu trúc thư mục định hướng

```text
stock-notifier/
├── AGENTS.md
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── IMPLEMENTATION_PLAN.md
│   └── ACCEPTANCE_CRITERIA.md
└── stock-notifier-app/
    ├── app/
    │   ├── modules/
    │   │   ├── shopify/graphql/
    │   │   ├── inventory/
    │   │   │   ├── inventory.service.ts
    │   │   │   ├── inventory-sync.service.ts
    │   │   │   └── inventory.repository.ts
    │   │   ├── alerts/alert.service.ts
    │   │   ├── notifications/telegram.service.ts
    │   │   └── settings/settings.service.ts
    │   ├── routes/
    │   │   ├── app._index.tsx
    │   │   ├── app.inventory.tsx
    │   │   ├── app.settings.tsx
    │   │   └── webhooks.inventory-levels-update.tsx
    │   ├── shopify.server.ts
    │   ├── db.server.ts
    │   └── routes.ts
    ├── prisma/
    │   ├── schema.prisma
    │   └── migrations/
    ├── package.json
    └── shopify.app.toml
```

Đây là **định hướng các file sẽ bổ sung**, không phải cây thư mục đã tồn tại hay yêu cầu tạo đủ từ ngày đầu. Các route và tên file cuối cùng phải phù hợp với `app/routes.ts` và conventions của phiên bản template đang cài. Giữ nguyên những route auth/webhook và generated files sẵn có.

## 3. Shopify integration

- Tối thiểu cần `read_inventory`, `read_products`. Xác minh fields/scopes/webhook trên **`2026-07`** và thêm `read_locations` **chỉ nếu** truy vấn thực tế yêu cầu. Không xin write scopes.
- GraphQL: lấy active locations; lấy tracked inventory items, SKU, `available` tại selected location và toàn bộ `InventoryItem.variants` (kèm product metadata). Xử lý cursor pagination cả items và variants, variables và GraphQL errors; không dùng singular `variant` để giả định quan hệ 1:1.
- Lưu `shopDomain` từ session đã xác thực, `locationGid` từ selected location; không tin shop ID do client truyền.
- Một snapshot/alert cycle theo `shop + location + inventoryItem`; lưu metadata variants trong `variants Json`, không tạo snapshot hay message riêng cho từng variant. Đọc `InventoryLevel.updatedAt` để chống stale writes.
- Webhook `inventory_levels/update` mang `inventory_item_id`, `location_id`, `available`, `updated_at`. So sánh location legacy ID đúng kiểu với GID đã lưu; không suy diễn item không tracked thành quantity 0.
- Webhook không nhất thiết mang product metadata: với inventory item chưa có trong snapshot, bổ sung metadata bằng GraphQL hoặc để lần sync kế tiếp xử lý; không hiển thị bản ghi thiếu định danh giả.
- Khai báo subscription theo cấu hình app/template được tạo, bao gồm webhook uninstall bắt buộc nếu template yêu cầu. Dùng `authenticate.webhook(request)` để kiểm chữ ký. Không dùng auth của UI trên webhook route.
- Shopify có thể gửi trùng, sai thứ tự hoặc bị lỡ webhook; hỗ trợ **Sync Now** để đối soát thủ công.

Tài liệu API chính thức: [React Router package](https://shopify.dev/docs/api/shopify-app-react-router/latest), [InventoryItem 2026-07](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/InventoryItem), [InventoryLevel 2026-07](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/InventoryLevel), [Webhooks 2026-07](https://shopify.dev/docs/api/webhooks/2026-07), [Webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries), [Telegram Bot API](https://core.telegram.org/bots/api).

### Full Sync và đổi location

- Thu thập kết quả mọi trang vào bộ nhớ cho MVP local; không ghi snapshot hoặc giữ DB transaction trong khi gọi Shopify. Scan lỗi, thiếu trang hoặc GraphQL errors thì bỏ kết quả scan, giữ nguyên snapshots, alerts và `lastSyncedAt` trước đó.
- Scan thành công toàn bộ mới áp dụng trong một transaction: upsert items hợp lệ với `isCurrent = true`, đánh dấu items không còn hợp lệ `isCurrent = false`, resolve active alerts của items đó, đánh giá transition nếu không phải baseline và cập nhật `lastSyncedAt`. Giữ snapshots cũ và lịch sử alert; chỉ gọi Telegram sau commit.
- Trước commit, kiểm tra selected location/baseline vẫn phù hợp; hủy kết quả scan nếu location đã đổi. Dùng cùng cơ chế lock/chống stale với webhook; đối soát các cập nhật đồng thời để scan không ghi đè hoặc vô hiệu hóa snapshot mới hơn.
- Đổi location trong một transaction: resolve active alerts location cũ, đặt snapshots cũ `isCurrent = false`, chuyển location và reset `lastSyncedAt = null`. Initial sync sau đó là baseline mới, kể cả quay lại location cũ; trước khi baseline thành công không đánh giá transition/gửi Telegram tự động.
- UI và threshold evaluation chỉ đọc items `isCurrent = true` tại selected location sau baseline. Một scan thành công với 0 items vẫn cập nhật `lastSyncedAt` và vô hiệu hóa dữ liệu cũ trong scope đó.

## 4. State transition và ví dụ Mermaid

Hàm quyết định: `isLowStock = availableQuantity <= lowStockThreshold`. `OUT_OF_STOCK` là nhãn UI khi quantity bằng 0; business state vẫn là `LOW_STOCK`.

```mermaid
stateDiagram-v2
    [*] --> NORMAL: quantity > threshold
    [*] --> LOW_STOCK: quantity <= threshold (sync baseline)
    NORMAL --> LOW_STOCK: Webhook decreases quantity / create alert
    LOW_STOCK --> LOW_STOCK: Still low / no new alert
    LOW_STOCK --> NORMAL: Restock / resolve active alert
    NORMAL --> NORMAL: Still normal / no alert
```

Thay biểu đồ ảnh gốc bằng dữ liệu minh họa dạng Mermaid (đường 1: quantity; đường 2: threshold = 5):

```mermaid
xychart-beta
    title "Available inventory over time"
    x-axis ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"]
    y-axis "Quantity" 0 --> 20
    line [15, 12, 8, 4, 3, 2, 12, 7, 4]
    line [5, 5, 5, 5, 5, 5, 5, 5, 5]
```

12:00 tạo alert; 13:00–14:00 không gửi lại; 15:00 resolve; 17:00 tạo alert mới.

## 5. Webhook transaction & Telegram

```mermaid
flowchart TD
    A["Webhook POST"] --> B{"HMAC hợp lệ?"}
    B -->|No| R["Reject"]
    B -->|Yes| C{"Selected location?"}
    C -->|No| OK["Return 2xx"]
    C -->|Yes| D["Begin DB transaction"]
    D --> E{"Webhook ID đã xử lý?"}
    E -->|Yes| I
    E -->|No| F{"Payload cũ hơn snapshot?"}
    F -->|Yes| G["Mark delivery processed"]
    F -->|No| H["Lock/upsert inventory; transition only after baseline"]
    H --> G
    G --> I["Commit transaction"]
    I --> J{"New alert PENDING?"}
    J -->|No| OK
    J -->|Yes| K["Send Telegram after commit"]
    K --> L["Save SENT / FAILED"]
    L --> OK
```

**Quy tắc bắt buộc:**

1. Unique `(shopDomain, webhookId)`; ghi nhận delivery **trong cùng transaction** với inventory và alert. Nếu transaction lỗi, rollback delivery ID để Shopify có thể retry.
2. Lock hàng inventory (hoặc atomic conditional update/serializable retry) khi đánh giá trạng thái; không tạo hai `ACTIVE` alerts do webhook đồng thời.
3. Bỏ qua event `updated_at` **cũ hơn** snapshot đã lưu; khi timestamp bằng nhau nhưng quantity mâu thuẫn, ưu tiên đối soát GraphQL/Sync Now, không ghi đè mù quáng.
4. Database commit trước khi gọi Telegram. Telegram lỗi: lưu `FAILED`, webhook vẫn trả 2xx nếu DB đã commit. Nếu DB lỗi: trả lỗi 5xx để Shopify retry. Đặt timeout ngắn (ví dụ 2 giây) cho Telegram để webhook có thể phản hồi nhanh.
5. `PENDING` sau crash có thể cần retry thủ công; crash đúng sau khi Telegram gửi nhưng trước khi ghi `SENT` có thể gây gửi lại. **Không cam kết exactly-once giữa PostgreSQL và Telegram**.
6. **Initial sync** khi `lastSyncedAt = null` chỉ thiết lập baseline, không tạo alert/gửi Telegram. **Sync Now tiếp theo** dùng chung Alert Engine với webhook; item mới hoặc trở lại current chỉ nhận baseline. Đổi threshold rebase `isLowStock` của items current sau baseline và resolve alerts không còn hợp lệ, không tạo alert mới. Mọi inventory/settings writer phải lock cùng hàng `ShopSettings`; sync kiểm tra lại `updatedAt` trước commit để hủy scan dùng cấu hình cũ. Inventory và alert transitions nằm trong cùng transaction; partial unique ACTIVE index là chốt chống trùng. Full sync và đổi location tuân theo mục 3.

Webhook handler chỉ sử dụng source shop và event data đã xác thực. Secrets (`SHOPIFY_API_SECRET`, token Telegram, DB URL) trong `.env` local, không commit Git. Việc kiểm chứng behavior nằm trong [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md).
