# Tailored Data Room — Backend

A secure virtual Data Room API for due-diligence document storage, built with NestJS, PostgreSQL, and Prisma. Users authenticate with Google, organize documents in nested folders inside a Data Room, and share folders or individual files with a public link or specific people.

Live API: `https://tailored-be-production.up.railway.app`
Frontend repository: [tailored-fe](https://github.com/MaksymChukhrai/tailored-fe)

## Table of Contents

- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Data Model](#data-model)
- [How It Scales](#how-it-scales)
- [Design Decisions](#design-decisions)
- [Local Setup](#local-setup)
- [Running with Docker](#running-with-docker)
- [Environment Variables](#environment-variables)
- [Note on AI Usage](#note-on-ai-usage)

## Tech Stack

**Framework & language**
- **NestJS** — modular Node.js framework; provides dependency injection, guards, pipes, and a clear separation between controllers and services.
- **TypeScript** (strict mode) — no `any`, explicit return types on public methods, `unknown` in catch blocks.

**Database & ORM**
- **PostgreSQL** (hosted on Railway) — relational database, chosen for its native support of transactions and constraints needed by the folder/file tree.
- **Prisma** — type-safe ORM and migration tool; generates a fully typed client from `schema.prisma`.

**Authentication**
- **Passport.js** with `passport-google-oauth20` — handles the Google OAuth2 handshake.
- **passport-jwt** — validates our own JWTs on protected routes.
- **@nestjs/jwt** — signs and verifies access/refresh tokens.
- **cookie-parser** — reads httpOnly cookies from incoming requests.

Session tokens (access + refresh) are issued by our own backend after a successful Google login and stored as httpOnly cookies — Google's own tokens are used once during login and never persisted.

**File storage**
- **@aws-sdk/client-s3** and **@aws-sdk/s3-request-presigner** — S3-compatible SDK used against **Cloudflare R2** (not AWS itself). Generates short-lived signed download URLs instead of exposing permanent public links.
- **multer** (`@nestjs/platform-express`) — parses multipart file uploads in memory before forwarding them to R2.

**Validation & safety**
- **class-validator** / **class-transformer** — declarative DTO validation and payload transformation.
- **Joi** — validates required environment variables on startup; the app refuses to boot with a misconfigured `.env`.
- **@nestjs/throttler** — basic rate limiting to slow down abuse of public endpoints (e.g. share links).

**Deployment**
- **Docker** (multi-stage build) — compiles TypeScript in a `builder` stage, ships only production dependencies and compiled JS in the `runner` stage.
- **Railway** — hosts both the PostgreSQL instance and the backend container; auto-deploys on every push to `main`.
- **Cloudflare R2** — S3-compatible object storage with no egress fees, used for all uploaded files.

## Project Structure

```
be/
├── prisma/
│   ├── schema.prisma          Data model (see below)
│   └── migrations/            Generated SQL migrations
├── src/
│   ├── access-control/        Single source of truth for "can this user view X" —
│   │                          checks ownership or share-based access across the tree
│   ├── auth/                  Google OAuth flow, JWT strategies, guards, decorators
│   ├── common/
│   │   └── filters/           Global exception filter — normalizes all errors
│   │                          (NestJS, Prisma, unexpected) into one JSON shape
│   ├── config/                Typed configuration + environment validation (Joi)
│   ├── data-rooms/            Data Room CRUD — the top-level container per user
│   ├── files/                 Upload, download (signed URL), rename, move, delete
│   ├── folders/               Nested folder CRUD, breadcrumbs, move, delete-preview
│   ├── health/                Root health-check endpoint
│   ├── prisma/                PrismaClient wrapped as an injectable NestJS service
│   ├── shares/                Public-link and permissioned sharing, revoke, access log
│   ├── storage/               Storage abstraction over Cloudflare R2 (S3 SDK)
│   ├── tree/                  Materialized-path helpers and aggregate maintenance,
│   │                          shared by folders and files
│   ├── users/                 User lookup/upsert from Google profile
│   ├── app.module.ts
│   └── main.ts
├── Dockerfile
├── railway.json
└── .env.example
```

Each feature folder follows the same shape: a `*.module.ts`, `*.controller.ts`, `*.service.ts`, and a `dto/` folder for request validation.

## Data Model

```
User ──< DataRoom ──< Folder ──< Folder (self-referencing, nested)
  │           │            │
  │           │            └──< File ──< FileVersion
  │           │
  │           └──< File (root-level files, folderId = null)
  │
  └──< RefreshToken

Share ──> DataRoom | Folder | File   (exactly one, polymorphic target)
  ├──< ShareGrantee ──> User          (permissioned mode only)
  └──< ShareAccessLog ──> User?       (nullable — anonymous public-link views)
```

Key modeling choices:

- **`Folder.path`** — a materialized path storing the chain of ancestor folder IDs (e.g. `/roomId/parentId/`). Enables O(1) "is this folder inside that one" checks and single-query subtree reads, instead of recursive queries on every request.
- **`totalSize` / `itemCount`** on both `DataRoom` and `Folder` — denormalized aggregates for the whole subtree, updated incrementally on every upload/delete/move rather than recomputed on read.
- **`Share`** has three nullable foreign keys (`dataRoomId`, `folderId`, `fileId`); exactly one is set per row, enforced in the service layer. This keeps one sharing table instead of three near-duplicate ones.
- **`Share.role`** is an enum (`VIEWER`, `EDITOR`) even though the MVP only ever issues `VIEWER` — see "How It Scales" below.
- **`FileVersion`** exists as a placeholder for version history on name conflicts (not required for the MVP, but the model is ready).

## How It Scales

**Computing a folder's total size and item count including its whole subtree**
Reads never walk the tree: `totalSize` and `itemCount` are columns on `Folder`/`DataRoom`, updated incrementally inside the same transaction as the mutation that caused the change (upload, delete, move). A file upload, for example, increments the counters on every ancestor folder (derived from `path`) and the owning Data Room in one `updateMany` call — an O(depth) operation, not O(subtree size). A `recomputeSubtreeAggregates` method exists as a repair path (e.g. after a move) that recalculates from scratch via `path LIKE 'prefix%'`, but this is not on the hot read path.

**What changes at 100,000 files in one Data Room**
- **Listing**: current folder listings already query by `folderId`/`parentId`, which is indexed — this holds at scale. What's missing for a UI at that size is cursor-based pagination on the listing endpoints (currently they return the full folder/file arrays); switching to `cursor` + `take` on `id` or `createdAt` avoids the cost and inconsistency of offset pagination on a frequently-changing table.
- **Indexes**: `Folder` and `File` already carry indexes on `dataRoomId`, `parentId`/`folderId`, and `path`. At 100k+ files, a composite index on `(dataRoomId, folderId, name)` would speed up the name-conflict checks that currently run on every create/rename/move.
- **Search**: the "search by file name" extra-credit feature would need a `pg_trgm` GIN index (or an external search index) rather than `LIKE` scans once the table grows past low tens of thousands of rows.

**Extending sharing to per-user roles (viewer/editor) without remodeling**
The schema already stores `Share.role` as an enum with `VIEWER` and `EDITOR` values — the MVP simply never issues `EDITOR`. Adding real editor support is a guard-logic change, not a schema migration: `AccessControlService` would grow a second method (`assertCanEdit`) that additionally checks `share.role === EDITOR`, and the write endpoints in `folders`/`files` controllers would accept that check as an alternative to strict ownership. No new tables or columns are needed.

## Design Decisions

- **Google OAuth only, no email/password** — the take-home spec allows either; Google-only was chosen to keep the auth surface smaller while still meeting the "authentication is required" requirement.
- **Access and refresh tokens as httpOnly cookies** — neither token is readable by JavaScript, which protects against XSS token theft. Refresh tokens are additionally stored server-side as SHA-256 hashes in a `RefreshToken` table, so a session can be revoked (logout, or a compromised token) without waiting for expiry. Refresh tokens rotate on every use.
- **Frontend and backend on different domains** (Vercel and Railway) means cookies must be sent cross-site; the frontend proxies API calls through a same-origin rewrite so the browser treats the whole app as one site, avoiding `SameSite=None` reliability issues in stricter browsers.
- **Presigned URLs instead of public file links** — even though the R2 bucket has a public development URL enabled, files are only ever served through short-lived signed URLs issued by the API after an access check. The public URL is not handed out directly; storage keys are UUID-based and not guessable.
- **Automatic name-conflict resolution for files** (`report.pdf` → `report (1).pdf`), matching the behavior of common file managers, versus a hard rejection for folders — files are uploaded in bulk and blocking on every conflict would break the multi-upload flow described in the spec; folders are created one at a time by explicit user action, so surfacing the conflict directly is more useful.
- **Soft revoke for shares** (`revokedAt` timestamp) rather than deletion — preserves the access log and produces a clear "this link was revoked" state instead of an ambiguous 404.
- **Deleting a folder that's being viewed via a share** — cascading deletes remove the folder, its contents, and any `Share` rows targeting it in the same operation. A viewer polling that share afterward gets a clean `404 Not Found` from the global exception filter, not a partial or broken response.

## Local Setup

### Prerequisites

- Node.js 22+
- npm
- A PostgreSQL database (local, or a Railway/Supabase instance)
- A Google OAuth 2.0 Client ID and Secret
- A Cloudflare R2 bucket and API token (or another S3-compatible bucket)

### Steps

```bash
git clone https://github.com/MaksymChukhrai/tailored-be.git
cd tailored-be
npm install
cp .env.example .env
```

Fill in `.env` with your own values (see [Environment Variables](#environment-variables) below), then:

```bash
npx prisma migrate dev
npm run start:dev
```

The API will be available at `http://localhost:3000`.

## Running with Docker

A standalone image can be built and run for this repository alone:

```bash
docker build -t tailored-be .
docker run -p 3000:3000 --env-file .env tailored-be
```

### Running frontend + backend together

Because the frontend and backend live in separate repositories but are commonly checked out as sibling folders (`code/be` and `code/fe`) on the same machine, the combined local setup — cloning both repos and starting them together with a single `docker compose` command from the parent `code/` folder — is documented in the [frontend repository's README](https://github.com/MaksymChukhrai/tailored-fe#running-both-services-together).

## Environment Variables

See `.env.example` for the full list. At minimum you need:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `FRONTEND_URL` | Used for CORS and post-login redirects |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Signing secrets for access/refresh tokens |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | Google OAuth credentials |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_PUBLIC_URL` | Cloudflare R2 storage credentials |

## Note on AI Usage

This backend was built in collaboration with Claude (Anthropic), used throughout the project for: scaffolding the NestJS module structure, designing the Prisma schema (including the materialized-path and denormalized-aggregate approach described above), writing service and controller logic, debugging the Docker/Railway deployment (Alpine's OpenSSL/musl incompatibility with Prisma's engine, TypeScript build configuration issues), and drafting this README. All architectural trade-offs — the choice of Google-only auth, the access-control model, the sharing schema — were discussed and decided on before implementation rather than generated unprompted.
