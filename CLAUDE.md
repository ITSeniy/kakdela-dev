# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**КакДела** — a self-hosted, cozy chat app for 15–20 friends, similar to Discord. The codebase theme is *Samurai Pizza Cats* (service names only). The product targets Windows-first desktop users via a Tauri 2 client. MVP goal: text channels + voice + screen sharing.

Always read `.claude/CURRENT_PHASE.md` before starting any task — it tells you what phase is active and what is explicitly out of scope.

---

## Commands

```bash
# Install dependencies
pnpm install

# Infrastructure (postgres, redis, minio, livekit)
pnpm docker:dev
pnpm docker:down
pnpm docker:reset   # ⚠ deletes all data

# Development
pnpm dev:speedy     # backend in watch mode (tsx watch)
pnpm dev:polly      # Tauri desktop window
pnpm dev:web        # browser-only (Vite, no Tauri), http://localhost:1420

# Database
pnpm francine migrate
pnpm francine seed

# Type checking (all packages)
pnpm typecheck

# Lint (all packages)
pnpm lint

# Build (all packages)
pnpm build
```

**Single-package commands** use the `--filter` flag:
```bash
pnpm --filter @kakdela/speedy typecheck
pnpm --filter @kakdela/polly tauri:build    # NSIS .exe installer → src-tauri/target/release/bundle/nsis/
pnpm --filter @kakdela/speedy db:generate   # drizzle-kit generate
pnpm --filter @kakdela/speedy db:studio     # drizzle-kit studio
```

**Tauri build prerequisite**: the Rust crate pulls in libsignal (secret chats), whose
`spqr` build script needs the Protocol Buffers compiler `protoc` on `PATH` (or via the
`PROTOC` env var). Install it (`choco install protoc` / `scoop install protobuf` /
`winget install protobuf`) before `tauri:build`, else the build fails at `spqr`.
Windows bundles NSIS only — the MSI (WiX) target was dropped because `light.exe` chokes
on the Cyrillic product name «как дела» under the `en-US` culture.

**VPS deploy**: full guide in `docs/DEPLOY.md`. Two compose files on a shared `kd-net` network: `docker-compose.prod.yml` (data: postgres/redis/minio/livekit/backup) + `docker-compose.app.yml` (speedy + caddy with the web client baked in). Secrets template: `.env.prod.example`; LiveKit config template: `ops/livekit/livekit.prod.example.yaml`. The speedy image runs on tsx (not compiled dist — ginzu exports TS sources) and bundles francine for migrations/seeding.

---

## Architecture

### Monorepo packages

| Package | Name | Role |
|---|---|---|
| `packages/speedy` | `@kakdela/speedy` | Fastify v5 backend: REST API, WebSocket gateway, auth, LiveKit token issuing |
| `packages/polly` | `@kakdela/polly` | Tauri 2 desktop client: React 19, Vite, Tailwind, TanStack Query, Zustand |
| `packages/ginzu` | `@kakdela/ginzu` | Shared TS types, WS event contracts, design tokens — the single source of truth for cross-package types |
| `packages/francine` | `@kakdela/francine` | CLI: DB migrations (drizzle-kit), seeding, invite generation |
| `packages/big-cheese` | `@kakdela/big-cheese` | Admin CLI: promote/kick users, manage channels in prod |

### Data flow

- **All mutations** (send message, react, edit) go through **REST**, not WebSocket.
- **WebSocket** is receive-only for the client: it receives change notifications and triggers TanStack Query invalidation.
- **Voice/screen share** keeps media transport on LiveKit, but public signaling goes through speedy `/livekit`. `POST /api/voice/:channelId/join` issues a gateway-only ticket; admission verifies PostgreSQL membership and elevates a restricted SFU bootstrap session under a membership lock before releasing signaling. SFU admin/signaling 7880 stays private; full reconnect is required. See `audit-admission.md` for rollout prerequisites. LiveKit webhooks still call `POST /api/internal/livekit-webhook`.

### Key files

- `packages/ginzu/src/ws-events.ts` — canonical `ServerEvent` and `ClientEvent` union types
- `packages/ginzu/src/api-types.ts` — `User`, `Channel`, `Message`, etc.
- `packages/speedy/src/media/guido.ts` — LiveKit token issuing (the "guido" module)
- `packages/polly/src/lib/host/` — abstraction layer over Tauri APIs; has mocks for `pnpm dev:web`
- `packages/polly/src/styles/tokens.css` — CSS variables for the KD warm beige design system

### Tauri isolation rule

All Rust/native code lives in `packages/polly/src-tauri/`. Business logic **never** calls `@tauri-apps/*` directly — it goes through `packages/polly/src/lib/host/`, which has a browser-compatible mock path. This allows running the UI in a plain browser with `pnpm dev:web`.

### Database

PostgreSQL with drizzle-orm. Migrations live in `packages/speedy/drizzle/`. Snake_case column names in DB, camelCase in API/frontend (converted in drizzle mapper or Zod schema). Presence and "is typing" state live **only in Redis**, not Postgres.

---

## Conventions (enforced — see `.claude/CONVENTIONS.md` for full detail)

- **TypeScript strict mode everywhere** (`noUncheckedIndexedAccess: true`). No `.js` in `/src/`.
- **Naming**: files `kebab-case.ts`, React components `PascalCase.tsx`, constants `SCREAMING_SNAKE_CASE`.
- **Imports**: group as stdlib → external → `@kakdela/*` → relative. Max two levels of `../`.
- **Speedy routes**: one file per domain (`auth.ts`, `messages.ts`, `voice.ts`), each exports a `FastifyPluginAsyncZod`.
- **Errors**: always return `{ error: { code, message } }`. Codes are `kebab-case`.
- **Design tokens**: never hardcode colors. Use `bg-kd-panel`, `text-kd-textSoft`, etc. (Tailwind extensions backed by `tokens.css` variables).
- **Auth tokens**: never `localStorage`. Desktop: OS-keychain via `keyring` crate (`os_secret_*` commands in `src-tauri/src/os_secrets.rs`; Windows Credential Manager / macOS Keychain / Linux secret-service) with lazy migration from the legacy IndexedDB AES-GCM vault (`packages/polly/src/lib/host/secrets.ts`). Access token in memory only. In web-only mode: `sessionStorage`.
- **Security**: argon2id (not bcrypt), Zod on every endpoint, magic-byte file validation, DOMPurify before any `dangerouslySetInnerHTML`.

### Prohibited

- ❌ `moment.js` — use `date-fns`
- ❌ UI kits (MUI, Chakra, shadcn) — components are hand-written from `designs/` reference files
- ❌ Redux — stack is TanStack Query + Zustand
- ❌ Emojis in server logs — they break grep/parsing
- ❌ Auth state in Zustand

---

## Task workflow

Tasks are tracked in `tasks/T-XXX.md` cards. Each card specifies recommended model, files in scope, and a DoD checklist.

| Task type | Model |
|---|---|
| Architecture decisions, security audit, subtle bugs (race conditions, WebRTC) | Opus 4.7, `high` reasoning |
| Feature implementation, new endpoints, UI from designs, migrations | Sonnet 4.6, default |
| Boilerplate, renaming, trivial fixes, config changes | Haiku 4.5, `low` |

Commit format: `feat: T-042 add voice join button` (conventional commits, task ID in body).

---

## Design system

Warm beige palette. Screens from `designs/final-*.jsx` are the visual reference for all UI work. When building components:

1. Use `--kd-*` CSS variables via Tailwind classes.
2. `--kd-mono` (JetBrains Mono) for technical labels (timestamps, sizes, IDs).
3. Default border-radius is `--kd-radius` (6px).
4. Theme switching: `data-theme="light"|"dark"` attribute on `<html>`.
