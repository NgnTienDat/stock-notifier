# StockNotifier — Technical Architecture

Phạm vi: [PRD.md](PRD.md). Schema: [DATABASE.md](DATABASE.md). Đây là **modular monolith**, một codebase Node.js và một PostgreSQL. Bước 8 bổ sung worker local dùng chung code/database để gửi Telegram bền vững; không thêm queue service hoặc scheduler ngoài.

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

**M2 runtime:** worker local dùng `unauthenticated.admin(shop)` với shop từ Session offline đã lưu, discovery đầy đủ bằng getLocations rồi reconcile MonitoredLocation trong transaction. Mỗi location scan ngoài transaction, xác minh active lại sau scan, commit riêng. `ShopSettings.locationsDiscoveredAt` đánh dấu cutover; trước discovery thành công đầu tiên chỉ giữ compatibility dữ liệu legacy. Sau đó location/baseline/version lấy từ MonitoredLocation; các trường location legacy chỉ giữ preference và routing webhook cũ đến M3.

Lock order: shop trước, location sau. Sync giữ `FOR SHARE` trên ShopSettings để đọc cấu hình ổn định, `FOR UPDATE` trên một MonitoredLocation và kiểm tra BigInt version; mỗi inventory writer tăng version của location. Threshold/discovery/uninstall lấy shop `FOR UPDATE`; threshold lock locations theo GID. Thay threshold/Chat ID tăng shop.updatedAt để hủy scan cấu hình cũ. Discovery đồng thời kiểm tra cả updatedAt và locationsDiscoveredAt; không giữ transaction khi gọi Shopify.

Worker inventory tái sử dụng entry/build worker hiện có ở mode `--inventory`, chạy process local riêng với vòng 60 giây, tuần tự shops/locations; tách process giúp scan dài không chặn Telegram. Một lần GraphQL tối đa 3 attempts, conflict scan tối đa 2; vòng sau retry locations lỗi, bỏ qua location vừa sync thành công chưa đủ 60 giây. Snapshot/mốc sync trong PostgreSQL giúp restart đối soát lại an toàn; không có fire-and-forget hoặc external queue. Có thể mất transition trung gian giữa hai lần poll; routing webhook mọi location và lifecycle/recovery đầy đủ chờ M3.

- Tối thiểu cần `read_inventory`, `read_products`. Xác minh fields/scopes/webhook trên **`2026-07`** và thêm `read_locations` **chỉ nếu** truy vấn thực tế yêu cầu. Không xin write scopes.
- GraphQL: lấy active locations; lấy tracked inventory items, SKU, `available` tại selected location và toàn bộ `InventoryItem.variants` (kèm product metadata). Xử lý cursor pagination cả items và variants, variables và GraphQL errors; không dùng singular `variant` để giả định quan hệ 1:1.
- Lưu `shopDomain` từ session đã xác thực, `locationGid` từ selected location; không tin shop ID do client truyền.
- Một snapshot/alert cycle theo `shop + location + inventoryItem`; lưu metadata variants trong `variants Json`, không tạo snapshot hay message riêng cho từng variant. Đọc `InventoryLevel.updatedAt` để chống stale writes.
- Webhook `inventory_levels/update`, `connect`, `disconnect` dùng cùng route `/webhooks/inventory`. Giữ chính xác legacy ID 64-bit khi chuyển sang GID; không cắt query string của level GID. Dùng webhook làm tín hiệu đọc lại `InventoryItem.inventoryLevel(locationId)` và metadata/variants qua GraphQL; không ghi quantity từ payload. Disconnect không có `updated_at`, nên cũng đọc lại để tránh vô hiệu hóa level đã reconnect. Không suy diễn item không tracked thành quantity 0.
- Webhook không nhất thiết mang product metadata: với inventory item chưa có trong snapshot, bổ sung metadata bằng GraphQL hoặc để lần sync kế tiếp xử lý; không hiển thị bản ghi thiếu định danh giả.
- Khai báo subscription theo cấu hình app/template được tạo, bao gồm webhook uninstall bắt buộc nếu template yêu cầu. Dùng `authenticate.webhook(request)` để kiểm chữ ký. Không dùng auth của UI trên webhook route.
- Shopify có thể gửi trùng, sai thứ tự hoặc bị lỡ webhook; hỗ trợ **Sync Now** để đối soát thủ công.

Tài liệu API chính thức: [React Router package](https://shopify.dev/docs/api/shopify-app-react-router/latest), [InventoryItem 2026-07](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/InventoryItem), [InventoryLevel 2026-07](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/InventoryLevel), [Webhooks 2026-07](https://shopify.dev/docs/api/webhooks/2026-07), [Webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries), [Telegram Bot API](https://core.telegram.org/bots/api).

### Full Sync và đổi location

- Thu thập kết quả mọi trang vào bộ nhớ cho MVP local; không ghi snapshot hoặc giữ DB transaction trong khi gọi Shopify. Scan lỗi, thiếu trang hoặc GraphQL errors thì bỏ kết quả scan, giữ nguyên snapshots, alerts và `lastSyncedAt` trước đó.
- Scan thành công toàn bộ mới commit mỗi location: upsert current snapshots, vô hiệu items thiếu/resolve alerts, áp dụng Alert Engine và cập nhật lastSyncedAt/baseline/version riêng. Lỗi A không rollback B. Thiếu available trong scan M2 là lỗi, không biến thành empty scan/zero.
- Trước commit kiểm tra shop config version, location active/version và session offline (nếu dùng); hủy stale scans. Webhook legacy dùng cùng location lock/version sau cutover. Shopify không cung cấp snapshot xuyên pagination; kiểm tra active sau scan và local fencing giảm race, không bảo đảm snapshot remote tuyệt đối.
- Sau cutover, đổi preference legacy không tác động monitoring/baseline/alerts. Chỉ discovery toàn bộ thành công mới đánh dấu locations không còn active, vô hiệu snapshots và resolve alerts; lỗi discovery không áp dụng kết quả một phần.
- Threshold tính lại current items thuộc tất cả monitored active locations, tạo THRESHOLD_CHANGE khi mới low, resolve khi hết low. Không phát Telegram riêng lẻ. Empty scan đã xác minh vẫn cleanup đúng location.

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
    C -->|Yes| READ["Read current GraphQL state outside transaction"]
    READ --> D["Begin transaction; lock ShopSettings"]
    D --> E{"Webhook ID đã xử lý?"}
    E -->|Yes| I
    E -->|No| V{"Version/location/session still valid?"}
    V -->|Conflict| RETRY["Rollback; return 503 for retry"]
    V -->|Yes| F{"GraphQL snapshot older than stored?"}
    F -->|Yes| G["Mark delivery processed"]
    F -->|No| H["Upsert/invalidate inventory; shared alert transitions after baseline"]
    H --> G
    G --> I["Commit transaction"]
    I --> OK
    I -.-> WORKER["Separate local worker claims scheduled alert from PostgreSQL"]
    WORKER --> K["Telegram outside DB transaction and webhook request"]
    K --> L["Fenced update: SENT or FAILED + bounded retry"]
```

**Quy tắc bắt buộc:**

1. Unique `(shopDomain, webhookId)`; ghi nhận delivery **trong cùng transaction** với inventory và alert. Nếu transaction lỗi, rollback delivery ID để Shopify có thể retry.
2. Lock hàng inventory (hoặc atomic conditional update/serializable retry) khi đánh giá trạng thái; không tạo hai `ACTIVE` alerts do webhook đồng thời.
3. Payload cũ chỉ kích hoạt đối soát GraphQL, không ghi trực tiếp. Snapshot GraphQL cũ hơn `shopifyUpdatedAt` đã lưu bị bỏ qua; timestamp bằng nhau dùng kết quả đọc GraphQL hiện tại. Đọc API ngoài transaction, sau đó lock ShopSettings và kiểm tra lại version/location/session trước commit, kể cả kết quả âm (deleted/disconnected). Mỗi inventory commit tăng `updatedAt` đơn điệu để vô hiệu hóa scan/read đồng thời, không đổi `lastSyncedAt` của full sync. Conflict trả 503 để Shopify retry; thiếu session/settings thì ACK và đối soát thủ công sau khi khôi phục auth. Uninstall xóa session dưới cùng shop lock.
4. Trong transaction tạo alert mới, chỉ lên lịch khi đã có bot token và Chat ID: lưu destination/text bất biến cùng alert. Webhook/sync không gọi hoặc chờ Telegram. Worker local poll PostgreSQL, claim bằng `FOR UPDATE SKIP LOCKED`, lease 30 giây và token riêng; gửi bằng native fetch ngoài transaction (timeout 2 giây), chỉ ghi SENT/notifiedAt sau API `ok:true`. Telegram lỗi không rollback inventory/webhook.
5. Tối đa 3 lần claim/thử; retry lỗi transport, HTTP 429/5xx và API lỗi tạm thời sau 5/30 giây hoặc `retry_after` dài hơn. Lease/retry/finalize dùng đồng hồ PostgreSQL, token chặn stale worker; lease hết hạn được claim lại, hết lượt thành FAILED. Alert lịch sử hoặc tạo khi thiếu cấu hình có lịch NULL, không gửi hàng loạt khi cấu hình sau đó. Worker kiểm tra ACTIVE/current/selected location/session/Chat ID; job không còn hợp lệ bị hủy thành FAILED. Crash hoặc timeout sau khi Telegram đã nhận nhưng trước khi DB ghi SENT có thể gây gửi lại; không cam kết exactly-once. Thay cấu hình/resolve không thu hồi được HTTP send đang diễn ra.
6. **M2 baseline/catch-up:** Alert Engine nhận origin BASELINE để tạo ACTIVE cho low items, dùng partial unique index/skipDuplicates giữ nguyên ACTIVE cũ. baselineAlertsCompletedAt chỉ ghi cùng successful full-sync transaction, độc lập baselineCompletedAt M1. BASELINE/THRESHOLD_CHANGE không có lịch gửi riêng; worker chỉ claim INVENTORY_TRANSITION và không giả SENT/FAILED cho alerts chờ M4. Các jobs transition trước migration giữ origin INVENTORY_TRANSITION, nguyên retry/lease metadata. Trước discovery thành công đầu tiên, đường compatibility legacy vẫn giữ policy cũ để tránh đổi dữ liệu trước khi xác minh locations.

Webhook handler chỉ sử dụng source shop và event data đã xác thực. Secrets (`SHOPIFY_API_SECRET`, token Telegram, DB URL) trong `.env` local, không commit Git. Việc kiểm chứng behavior nằm trong [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md).
