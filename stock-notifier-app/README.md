# StockNotifier — local development

This is a template for building a [Shopify app](https://shopify.dev/docs/apps/getting-started) using [React Router](https://reactrouter.com/). It was forked from the [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix) and converted to React Router.

Reuse this repository's scaffold. Do not run `shopify app init` again.

Visit the [`shopify.dev` documentation](https://shopify.dev/docs/api/shopify-app-react-router) for more details on the React Router app package.

## Upgrading from Remix

If you have an existing Remix app that you want to upgrade to React Router, please follow the [upgrade guide](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix). Otherwise, please follow the quick start guide below.

## Quick start

### Prerequisites

Before you begin, you'll need to [download and install the Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started) if you haven't already.

### Setup

Run these commands from `stock-notifier-app/` with Node.js 22 LTS (>=22.12), Docker Desktop using Linux containers, and npm:

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Set a long URL-safe `POSTGRES_PASSWORD` in `.env` before starting PostgreSQL. `DATABASE_URL` references that password; Prisma 6 and Compose expand it. Keep `.env` private; only `.env.example` belongs in Git. Leave the Shopify credential values to Shopify CLI during development.

```powershell
docker compose config --quiet
docker compose up -d --wait
docker compose ps
npm run setup
npm run test:integration
```

Compose runs **only PostgreSQL 16**, on `127.0.0.1:5433`, with database/user `stocknotifier`, named volume `stocknotifier_postgres_data`, and a `pg_isready` healthcheck. Stop it with `docker compose stop`; start it again with `docker compose up -d --wait`. If port 5433 is occupied, inspect the existing container before changing anything; never delete its data to free the port.

`npm run setup` generates Prisma Client and applies committed PostgreSQL migrations. The original SQLite schema/migration are archived unchanged in `prisma/legacy-sqlite/`; the existing ignored `prisma/dev.sqlite` is retained, not imported or reset. Existing SQLite sessions would need a separate explicit transfer or Shopify reauthentication. This repository's inspected SQLite database contained 0 sessions during the conversion.

Database tests use the local Compose database and only create/delete uniquely named fixture shops/sessions. They verify JSON variants, scoped unique keys, one ACTIVE alert, rollback, threshold checks, history FKs, and the official session adapter. They do not contact Shopify or Telegram, or implement sync/webhooks.

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

### Local Development

```shell
shopify app dev
```

Press P to open the URL to your app. Once you click install, you can start development.

Local development is powered by [the Shopify CLI](https://shopify.dev/docs/apps/tools/cli). It logs into your account, connects to an app, provides environment variables, updates remote config, creates a tunnel and provides commands to generate extensions.

### StockPulse initial and manual inventory sync (Step 5)

Open **Settings → Inventory sync → Sync now** after saving a location. The button shows progress and reports how many items were synced and how many old snapshots became inactive. Reloading retains the last successful sync time (shown in UTC). Only the authenticated shop's saved location is used; the sync endpoint accepts no client-supplied shop or location.

The service reads every inventory and nested variant page into memory before opening a PostgreSQL transaction. It upserts one snapshot per `(shopDomain, locationGid, inventoryItemGid)`, preserves nullable SKU/zero/negative available quantities, stores all variant metadata, and calculates `isLowStock` with the inclusive threshold. Snapshots absent from a successful scan become `isCurrent = false`; their active alerts are resolved while history remains. A successful empty scan performs the same cleanup.

GraphQL page failures and database failures leave the previous inventory, alert state and `lastSyncedAt` unchanged. Location changes and sync commits lock the same ShopSettings row. Its `updatedAt` advances monotonically and is checked again before commit, so an overlapping sync or A→B→A change invalidates an old scan, including changes in the same millisecond. Newer stored inventory also aborts an older scan rather than being overwritten or invalidated. Conflicts return an error asking the merchant to retry. Future settings/inventory writers must follow this locking/version protocol.

The first sync with lastSyncedAt = null is a baseline, including after returning to a previous location. This step updates inventory snapshots and resolves alerts for invalidated items; creation of new low-stock alerts and manual-sync alert transitions belong to the next Alert Engine step. No webhook, Telegram, queue or cron is added. Shopify pagination remains a live remote read, not a transactional snapshot of Shopify.

The new tests target hidden failure/concurrency behavior: partial inventory/variant scans, transaction rollback after upserts and cleanup, tenant/location isolation, simultaneous syncs, same-millisecond location changes, stale writes and baseline/history preservation. Existing GraphQL unit tests cover pagination; no new UI interaction tests were added.

### StockPulse location selection (Step 4)

Open **Settings** in the embedded app navigation (`/app/settings`). Select one active location and save. Both the loader and action use `authenticate.admin(request)`; the action rechecks the current store's active Shopify locations, ignores client-supplied shop/name fields, and saves Shopify's location name to PostgreSQL.

Reloading retains the saved choice. API failures retain the existing selection and show a retry action; a removed/inactive saved location is shown with a warning. Changing location locks the shop's settings row and atomically resolves only the old location's ACTIVE alerts, marks its snapshots `isCurrent = false`, and resets `lastSyncedAt`. Alert history and quantities remain intact. Saving the same location only refreshes its name and preserves the baseline. Saving does not run inventory sync or send Telegram.

Use `127.0.0.1` in the local `DATABASE_URL`, matching Compose's port binding. Concurrent Prisma transaction tests failed to acquire a connection through `localhost` on the inspected Windows setup and passed through `127.0.0.1`.

```powershell
npm run test:unit
npm run test:integration
npm run typecheck
npm run lint
npm run build
```

The location integration suite executes loader/action with the real GraphQL service, mocked Shopify auth/responses and real local PostgreSQL. It verifies persistence with a fresh Prisma client, tenant/location isolation, rollback, concurrent selections and A→B→A without reusing a baseline. It only cleans up its uniquely named fixture shops.

For an optional **read-only live loader probe**, first open the app with `npm run dev` so Shopify refreshes the offline session. In another PowerShell terminal:

```powershell
$env:SHOPIFY_LIVE_TEST = '1'
npm exec -- vitest run tests/location-settings.live.test.ts
Remove-Item Env:SHOPIFY_LIVE_TEST
```

This read-only probe injects the saved offline session at the authentication boundary and calls Shopify GraphQL through the actual Settings loader. It does not change settings, test browser authentication or refresh an expired token. Normal npm test skips this network-dependent probe.

For the browser smoke test, select a location in Settings, save, reload and confirm the name remains selected. Change to a different location and verify `ShopSettings.locationGid/locationName`, `lastSyncedAt = null`, old snapshots no longer current and old ACTIVE alerts resolved. No sync or Telegram should occur.

### StockPulse GraphQL read service (Step 3)

The server-only module is `app/modules/shopify/graphql/shopify-graphql.server.ts`. Pass the existing authenticated context; never accept a shop domain from the browser:

```ts
const context = await authenticate.admin(request);
const shopifyReads = createShopifyGraphqlService(context);
const locations = await shopifyReads.getLocations();
// Use the authenticated shop's selected location from settings in a later milestone.
const levels = await shopifyReads.getInventoryLevels(selectedLocationGid);
const item = await shopifyReads.getInventoryItem(inventoryItemGid);
```

`getLocations()` returns active locations. `getInventoryLevels()` returns one record per tracked item at that location, including `availableQuantity`, nullable SKU, the complete variants metadata array and `shopifyUpdatedAt` as a Date. The Shopify `inventoryLevelGid` stays intact, including `?inventory_item_id=...`; it is separate from Prisma's app-owned `id`. Alert state, `isCurrent` and sync timestamps belong to the later sync milestone. This module performs no database writes.

Missing/untracked/inactive levels or missing `available` are omitted, never turned into zero. Zero and negative quantities are retained. A missing item returns `null`; a nullable variants connection becomes `[]`. A missing/inactive location, failure on any page, or an item disappearing during variant pagination rejects the entire read. GraphQL errors reject even with partial data. HTTP 429/5xx and GraphQL `THROTTLED` get at most three attempts; retries use `Retry-After` or query-cost/restore-rate data when supplied, with fallback backoff. Authentication Responses propagate unchanged. Shopify pagination is a live read, not a transactional snapshot of the remote store.

Run only mocked unit tests without Shopify credentials, PostgreSQL or Docker:

```powershell
npm run test:unit
```

Manual verification in Shopify GraphiQL:

1. Run `npm run dev` with the working linked app configuration; press **g** to open GraphiQL. Select Admin API **2026-07**. Required scopes are `read_inventory,read_products`; `read_inventory` also grants Location access ([Location access](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Location)). Existing additional `read_locations` does not need changing for this step.
2. Copy `StockPulseLocations` from `app/modules/shopify/graphql/queries.ts` into GraphiQL (the query inside the template string). Set variables to `{"first":2,"after":null}`. Repeat with `after = pageInfo.endCursor` until `hasNextPage` is false; choose an active location GID.
3. Run `StockPulseLocationInventory` with `{"locationId":"gid://shopify/Location/REPLACE","first":2,"after":null}`. Compare SKU and `quantities[name=available]` with Shopify Admin at that location. Follow the outer inventory cursor separately from each item's variants cursor. Keep level IDs exactly as returned.
4. For each item with `variants.pageInfo.hasNextPage = true`, run `StockPulseInventoryItem` with `{"id":"gid://shopify/InventoryItem/REPLACE","first":2,"after":"VARIANT_END_CURSOR"}` until finished. Use `after:null` to read an item from its first variant page. Confirm multiple variants remain one inventory item.

All three queries were checked with Shopify AI Toolkit against the 2026-07 schema. Field references: [InventoryItem](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/InventoryItem), [InventoryLevel](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/InventoryLevel), [rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits).

Existing config discrepancy outside Step 3: both app TOML files currently use webhook API `2027-01`, whereas runtime/codegen and the approved docs use `2026-07`. This step does not change webhook configuration or the existing demo routes.

### Authenticating and querying data

To authenticate and query data you can use the `shopify` const that is exported from `/app/shopify.server.js`:

```js
export async function loader({ request }) {
  const { admin } = await shopify.authenticate.admin(request);

  const response = await admin.graphql(`
    {
      products(first: 25) {
        nodes {
          title
          description
        }
      }
    }`);

  const {
    data: {
      products: { nodes },
    },
  } = await response.json();

  return nodes;
}
```

This template comes pre-configured with examples of:

1. Setting up your Shopify app in [/app/shopify.server.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/shopify.server.ts)
2. Querying data using Graphql. Please see: [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx).
3. Responding to webhooks. Please see [/app/routes/webhooks.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/webhooks.app.uninstalled.tsx).
4. Using metafields, metaobjects, and declarative custom data definitions. Please see [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx) and [shopify.app.toml](https://github.com/Shopify/shopify-app-template-react-router/blob/main/shopify.app.toml).

Please read the [documentation for @shopify/shopify-app-react-router](https://shopify.dev/docs/api/shopify-app-react-router) to see what other API's are available.

## Shopify Dev MCP

This template is configured with the Shopify Dev MCP. This instructs [Cursor](https://cursor.com/), [GitHub Copilot](https://github.com/features/copilot) and [Claude Code](https://claude.com/product/claude-code) and [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) to use the Shopify Dev MCP.

For more information on the Shopify Dev MCP please read [the documentation](https://shopify.dev/docs/apps/build/devmcp).

## Deployment

### Application Storage

StockNotifier uses [Prisma](https://www.prisma.io/) with PostgreSQL for sessions and the four MVP business tables; see the local setup above. The Shopify Prisma Session Storage adapter and Session fields are unchanged.
The database is defined as a Prisma schema in `prisma/schema.prisma`.

Production deployment is outside this MVP. The following provider suggestions are retained from the upstream template, not additional StockNotifier infrastructure requirements.
Here’s a short list of databases providers that provide a free tier to get started:

| Database   | Type             | Hosters                                                                                                                                                                                                                                    |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MySQL      | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mysql), [Planet Scale](https://planetscale.com/), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/mysql) |
| PostgreSQL | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-postgresql), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/postgres)                                   |
| Redis      | Key-value        | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-redis), [Amazon MemoryDB](https://aws.amazon.com/memorydb/)                                                                                                        |
| MongoDB    | NoSQL / Document | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mongodb), [MongoDB Atlas](https://www.mongodb.com/atlas/database)                                                                                                  |

To use one of these, you can use a different [datasource provider](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#datasource) in your `schema.prisma` file, or a different [SessionStorage adapter package](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md).

### Build

Build the app by running the command below with the package manager of your choice:

Using yarn:

```shell
yarn build
```

Using npm:

```shell
npm run build
```

Using pnpm:

```shell
pnpm run build
```

## Hosting

When you're ready to set up your app in production, you can follow [our deployment documentation](https://shopify.dev/docs/apps/launch/deployment) to host it externally. From there, you have a few options:

- [Google Cloud Run](https://shopify.dev/docs/apps/launch/deployment/deploy-to-google-cloud-run): This tutorial is written specifically for this example repo, and is compatible with the extended steps included in the subsequent [**Build your app**](tutorial) in the **Getting started** docs. It is the most detailed tutorial for taking a React Router-based Shopify app and deploying it to production. It includes configuring permissions and secrets, setting up a production database, and even hosting your apps behind a load balancer across multiple regions.
- [Fly.io](https://fly.io/docs/js/shopify/): Leverages the Fly.io CLI to quickly launch Shopify apps to a single machine.
- [Render](https://render.com/docs/deploy-shopify-app): This tutorial guides you through using Docker to deploy and install apps on a Dev store.
- [Manual deployment guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service): This resource provides general guidance on the requirements of deployment including environment variables, secrets, and persistent data.

When you reach the step for [setting up environment variables](https://shopify.dev/docs/apps/deployment/web#set-env-vars), you also need to set the variable `NODE_ENV=production`.

## Gotchas / Troubleshooting

### Database tables don't exist

If you get an error like:

```
The table `main.Session` does not exist in the current database.
```

Create the database for Prisma. Run the `setup` script in `package.json` using `npm`, `yarn` or `pnpm`.

### Navigating/redirecting breaks an embedded app

Embedded apps must maintain the user session, which can be tricky inside an iFrame. To avoid issues:

1. Use `Link` from `react-router` or `@shopify/polaris`. Do not use `<a>`.
2. Use `redirect` returned from `authenticate.admin`. Do not use `redirect` from `react-router`
3. Use `useSubmit` from `react-router`.

This only applies if your app is embedded, which it will be by default.

### Webhooks: shop-specific webhook subscriptions aren't updated

If you are registering webhooks in the `afterAuth` hook, using `shopify.registerWebhooks`, you may find that your subscriptions aren't being updated.

Instead of using the `afterAuth` hook declare app-specific webhooks in the `shopify.app.toml` file. This approach is easier since Shopify will automatically sync changes every time you run `deploy` (e.g: `npm run deploy`). Please read these guides to understand more:

1. [app-specific vs shop-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions)
2. [Create a subscription tutorial](https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started?deliveryMethod=https)

If you do need shop-specific webhooks, keep in mind that the package calls `afterAuth` in 2 scenarios:

- After installing the app
- When an access token expires

During normal development, the app won't need to re-authenticate most of the time, so shop-specific subscriptions aren't updated. To force your app to update the subscriptions, uninstall and reinstall the app. Revisiting the app will call the `afterAuth` hook.

### Webhooks: Admin created webhook failing HMAC validation

Webhooks subscriptions created in the [Shopify admin](https://help.shopify.com/en/manual/orders/notifications/webhooks) will fail HMAC validation. This is because the webhook payload is not signed with your app's secret key.

The recommended solution is to use [app-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions) defined in your toml file instead. Test your webhooks by triggering events manually in the Shopify admin(e.g. Updating the product title to trigger a `PRODUCTS_UPDATE`).

### Webhooks: Admin object undefined on webhook events triggered by the CLI

When you trigger a webhook event using the Shopify CLI, the `admin` object will be `undefined`. This is because the CLI triggers an event with a valid, but non-existent, shop. The `admin` object is only available when the webhook is triggered by a shop that has installed the app. This is expected.

Webhooks triggered by the CLI are intended for initial experimentation testing of your webhook configuration. For more information on how to test your webhooks, see the [Shopify CLI documentation](https://shopify.dev/docs/apps/tools/cli/commands#webhook-trigger).

### Incorrect GraphQL Hints

By default the [graphql.vscode-graphql](https://marketplace.visualstudio.com/items?itemName=GraphQL.vscode-graphql) extension for will assume that GraphQL queries or mutations are for the [Shopify Admin API](https://shopify.dev/docs/api/admin). This is a sensible default, but it may not be true if:

1. You use another Shopify API such as the storefront API.
2. You use a third party GraphQL API.

If so, please update [.graphqlrc.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/.graphqlrc.ts).

### Using Defer & await for streaming responses

By default the CLI uses a cloudflare tunnel. Unfortunately cloudflare tunnels wait for the Response stream to finish, then sends one chunk. This will not affect production.

To test [streaming using await](https://reactrouter.com/api/components/Await#await) during local development we recommend [localhost based development](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options#localhost-based-development).

### "nbf" claim timestamp check failed

This is because a JWT token is expired. If you are consistently getting this error, it could be that the clock on your machine is not in sync with the server. To fix this ensure you have enabled "Set time and date automatically" in the "Date and Time" settings on your computer.

### Using MongoDB and Prisma

If you choose to use MongoDB with Prisma, there are some gotchas in Prisma's MongoDB support to be aware of. Please see the [Prisma SessionStorage README](https://www.npmjs.com/package/@shopify/shopify-app-session-storage-prisma#mongodb).

### Unable to require(`C:\...\query_engine-windows.dll.node`).

Unable to require(`C:\...\query_engine-windows.dll.node`).
The Prisma engines do not seem to be compatible with your system.

query_engine-windows.dll.node is not a valid Win32 application.

**Fix:** Set the environment variable:

```shell
PRISMA_CLIENT_ENGINE_TYPE=binary
```

This forces Prisma to use the binary engine mode, which runs the query engine as a separate process and can work via emulation on Windows ARM64.

## Resources

React Router:

- [React Router docs](https://reactrouter.com/home)

Shopify:

- [Intro to Shopify apps](https://shopify.dev/docs/apps/getting-started)
- [Shopify App React Router docs](https://shopify.dev/docs/api/shopify-app-react-router)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- [Shopify App Bridge](https://shopify.dev/docs/api/app-bridge-library).
- [Polaris Web Components](https://shopify.dev/docs/api/app-home/polaris-web-components).
- [App extensions](https://shopify.dev/docs/apps/app-extensions/list)
- [Shopify Functions](https://shopify.dev/docs/api/functions)

Internationalization:

- [Internationalizing your app](https://shopify.dev/docs/apps/best-practices/internationalization/getting-started)
