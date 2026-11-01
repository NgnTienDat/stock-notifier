<h1 align="center">StockNotifier</h1>

<p align="center">
  Multi-location inventory monitoring and low-stock alerts for Shopify.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Shopify-7AB55C?style=flat-square" alt="Shopify">
  <img src="https://img.shields.io/badge/React_Router-CA4245?style=flat-square" alt="React Router">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square" alt="TypeScript">
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Prisma-2D3748?style=flat-square" alt="Prisma">
  <img src="https://img.shields.io/badge/Telegram-26A5E4?style=flat-square" alt="Telegram">
</p>

<p align="center">
  <a href="#overview">Overview</a> ·
  <a href="#features">Features</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#getting-started">Getting Started</a> ·
  <a href="#testing">Testing</a> ·
  <a href="#documentation">Documentation</a>
</p>

---

## Overview

StockNotifier is an embedded Shopify app that tracks inventory across every active location of a store and raises an alert when available stock falls below a configurable threshold. Alerts are recorded in the app and can be delivered to a Telegram chat.

Inventory is tracked per inventory item and location. Multiple variants, nullable SKUs, and zero or negative quantities are supported. Location filters in the dashboard only change the view; they do not affect what is monitored.

## Features

- Automatic discovery and monitoring of all active Shopify locations.
- Initial and manual inventory sync, inventory webhooks, and background reconciliation.
- Store-wide low-stock threshold with prevention of duplicate active alerts.
- Dashboard with location and stock filters, search, and server-side pagination.
- Alert history with active/resolved status and notification results.
- Telegram notifications: immediate messages on state transitions, and digests after the baseline sync or a threshold change.

## Screenshots

| Dashboard: all locations | Dashboard: low stock |
| :--- | :--- |
| ![Dashboard overview](docs/assets/screenshots/dashboard-overview.png) | ![Dashboard low stock](docs/assets/screenshots/dashboard-low-stock.png) |
| Inventory metrics and monitoring coverage across active locations. | Filtered inventory with available quantities, thresholds, and alert status. |

| Alert history | Settings |
| :--- | :--- |
| ![Alert history](docs/assets/screenshots/alert-history.png) | ![Settings](docs/assets/screenshots/settings_1.png) |
| Active and resolved alerts with origins and Telegram delivery results. | Store-wide threshold and automatic location monitoring status. |

| Settings: Telegram and sync |
| :--- |
| ![Settings: Telegram and sync](docs/assets/screenshots/settings_2.png) |
| Chat ID configuration, test message, and manual inventory synchronization. |

## Architecture

```mermaid
flowchart LR
    Admin["Shopify Admin"] --> App["Embedded React Router App"]
    Hooks["Shopify Webhooks"] --> App
    App <--> API["Shopify GraphQL API"]
    App --> DB[("PostgreSQL / Prisma")]
    DB <--> Inventory["Inventory Worker"]
    Inventory <--> API
    Inventory --> Alerts["Shared Alert Engine"]
    App --> Alerts
    Alerts --> DB
    DB <--> Worker["Telegram Worker"]
    Worker --> Telegram["Telegram"]
```

### Tech Stack

| Layer | Technology |
| :--- | :--- |
| Runtime | Node.js 22 LTS, TypeScript (strict) |
| App and UI | React 18, React Router 7, Polaris Web Components, App Bridge |
| Shopify | Admin GraphQL API and webhooks, version `2026-07` |
| Database | PostgreSQL 16, Prisma 6, Docker Compose |
| Notifications | Telegram Bot API |
| Testing | Vitest |

## Getting Started

### Prerequisites

- Node.js 22.12 or later (22 LTS), npm, and Git.
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli), if not already installed: `npm install -g @shopify/cli@latest`.
- A Shopify account with access to an app and a development store to install it on.
- Docker with Linux containers and a Compose version that supports `--wait`. Local port `5433` must be available.

### Installation

Run from the repository root. The commands below use PowerShell; use the equivalent copy command in other shells.

```powershell
cd stock-notifier-app
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

### Configuration

Edit `stock-notifier-app/.env`, using [`.env.example`](stock-notifier-app/.env.example) as the reference. All values below are placeholders; replace them privately.

```dotenv
# PostgreSQL: use a long, URL-safe password
POSTGRES_PASSWORD=replace_with_a_long_random_password
DATABASE_URL="postgresql://stocknotifier:${POSTGRES_PASSWORD}@127.0.0.1:5433/stocknotifier?schema=public"

# Shopify: must belong to the app used by the active CLI configuration
SHOPIFY_API_KEY=replace_with_your_app_client_id
SHOPIFY_API_SECRET=replace_with_your_app_secret
SHOPIFY_APP_URL=https://replace-with-current-tunnel.example
SCOPES=read_inventory,read_products,read_locations

# Telegram: optional; leave empty to disable bot delivery
TELEGRAM_BOT_TOKEN=replace_with_your_bot_token

# Optional timing defaults (milliseconds)
INVENTORY_RECONCILE_INTERVAL_MS=60000
INVENTORY_RETRY_BACKOFF_MS=60000
WEBHOOK_RETRY_BASE_MS=5000
```

| Variable | Required | Description |
| :--- | :--- | :--- |
| `POSTGRES_PASSWORD`, `DATABASE_URL` | Yes | Local PostgreSQL credentials and connection string. |
| `SHOPIFY_API_KEY` | Yes | Client ID of the Shopify app. |
| `SHOPIFY_API_SECRET` | Yes | Client secret of the same app. |
| `SHOPIFY_APP_URL` | Yes | Current HTTPS tunnel URL printed by the dev command. |
| `SCOPES` | Yes | Must match the scopes in the app TOML file. |
| `TELEGRAM_BOT_TOKEN` | No | Enables Telegram delivery when set. |
| `INVENTORY_RECONCILE_INTERVAL_MS`, `INVENTORY_RETRY_BACKOFF_MS`, `WEBHOOK_RETRY_BASE_MS` | No | Timing defaults. |

> [!NOTE]
> Shopify CLI injects credentials and the tunnel URL only into `app dev`. The standalone inventory worker reads `.env`, so `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SHOPIFY_APP_URL` must be filled in manually. Update them after starting the app, before starting the worker, and restart the worker whenever the tunnel URL changes.

> [!WARNING]
> Never commit `.env` or expose secrets through client-side variables.

### Database

```powershell
docker compose config --quiet
docker compose up -d --wait
docker compose ps
npm run setup
npm run build
```

Compose starts a single PostgreSQL 16 service with persistent storage on `127.0.0.1:5433`. `npm run setup` generates the Prisma Client and applies the committed migrations. `npm run build` compiles the app and workers.

### Shopify App

To use the provided configuration, you need access to its linked app: [`shopify.app.stock-notifier-app.toml`](stock-notifier-app/shopify.app.stock-notifier-app.toml). To use your own app, run:

```powershell
npm run config:link
```

Linking can create or overwrite configuration. Make sure the resulting file keeps:

- the inventory, location, and system webhooks;
- API version `2026-07`;
- automatic development URL updates;
- the scopes `read_inventory`, `read_products`, and `read_locations`.

If the configuration name differs from `stock-notifier-app`, use it in the `--config` flag below.

### Telegram (optional)

1. Create a bot with **@BotFather** and set `TELEGRAM_BOT_TOKEN` in your private `.env`.
2. Start a chat with the bot, or add it to a group.
3. Get the numeric Chat ID from [`getUpdates`](https://core.telegram.org/bots/api#getupdates).
4. Save the Chat ID in the app's Settings page and send a test message.

Restart the app and workers after changing the token. Configure Telegram before the first baseline sync to receive its digest; configuring it later does not send historical alerts.

## Running

Run each process from `stock-notifier-app/` in a separate terminal so that inventory processing and notification delivery stay independent.

**Terminal 1: app and webhook tunnel**

```powershell
npm run dev -- --config stock-notifier-app
```

Follow the CLI prompts, select your development store, and open the embedded app once to save an authenticated offline session. Then update the worker environment as described in [Configuration](#configuration).

**Terminal 2: location discovery, inventory webhooks, and reconciliation**

```powershell
npm run inventory:worker
```

**Terminal 3: Telegram delivery (optional)**

```powershell
npm run notifications:worker
```

Workers run built code. After changing worker code, run `npm run build:worker` and restart them.

## Testing

Run from `stock-notifier-app/`, with PostgreSQL running and setup completed. Stop the workers before running database tests.

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

Vitest covers unit-level rules and integration behavior against a real PostgreSQL instance, with Shopify and Telegram responses mocked. No credentials are needed for the standard test run.

Manual verification (M1–M4) on a development store is a separate step: check the dashboard and location filters, alert history, and real Telegram delivery. See the [app README](stock-notifier-app/README.md) for setup details, troubleshooting, and manual scenarios.

## Project Structure

```text
.
├── README.md                       Project overview and local setup
├── AGENTS.md                       Repository engineering instructions
├── docs/                           Product and technical specifications
│   └── assets/screenshots/         Development store screenshots
└── stock-notifier-app/             Shopify React Router application
    ├── app/
    │   ├── modules/
    │   │   ├── alerts/             Shared low-stock alert engine
    │   │   ├── dashboard/          Dashboard reads, filters, and UI
    │   │   ├── inventory/          Discovery, sync, and webhook processing
    │   │   ├── notifications/      Telegram delivery and digests
    │   │   ├── settings/           Store-wide configuration
    │   │   └── shopify/graphql/    Shopify Admin GraphQL service
    │   ├── routes/                 Embedded pages, actions, and webhooks
    │   └── workers/                Inventory and Telegram worker entry points
    ├── prisma/                     Schema and committed migrations
    ├── tests/                      Unit and PostgreSQL integration tests
    ├── .env.example                Environment template
    ├── compose.yaml                Local PostgreSQL service
    ├── package.json                Dependencies and scripts
    └── shopify.app.stock-notifier-app.toml
                                    Named Shopify app configuration
```

## Scope and Limitations

This project is a local, development-store MVP and carries no production-readiness guarantees.

- Dashboard data refreshes only on page reload.
- Telegram delivery can repeat if a crash occurs between a successful API call and the database confirmation, so exactly-once delivery is not guaranteed.
- Reconciliation restores the current state but cannot recover every inventory transition missed while the workers were offline.

## Documentation

| Document | Description |
| :--- | :--- |
| [Product requirements](docs/PRD.md) | Goals, users, and functional scope. |
| [Architecture](docs/ARCHITECTURE.md) | System design and component responsibilities. |
| [Database design](docs/DATABASE.md) | Schema and data model. |
| [Acceptance criteria](docs/ACCEPTANCE_CRITERIA.md) | Conditions for completing each feature. |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md) | Milestones and delivery order. |
| [Development notes](stock-notifier-app/README.md) | Detailed setup, troubleshooting, and manual test scenarios. |