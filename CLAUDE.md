# Working in pizza-parlor

**КакДела** is a self-hosted messenger for a small group of friends. Package names follow Samurai Pizza Cats. Start with [.claude/CURRENT_PHASE.md](.claude/CURRENT_PHASE.md), then [.claude/CONVENTIONS.md](.claude/CONVENTIONS.md) and the relevant task card.

## Documentation

- [Development](docs/DEVELOPMENT.md): environment, setup, commands and verification.
- [Architecture](ARCHITECTURE.md): current implementation and data flow.
- [Documentation index](docs/README.md): deployment, Android, backup and audit reports.
- [Tasks](tasks/README.md): specifications and acceptance criteria; old checkboxes are historical.

## Commands

Use **Node 24 / pnpm 9.12.0** as pinned by the manifest and CI. Run commands from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm docker:dev
pnpm dev:speedy
pnpm dev:web
# Desktop instead of web:
pnpm dev:polly

pnpm typecheck
pnpm --filter @kakdela/speedy exec tsc -p tsconfig.admission-tests.json
pnpm lint
pnpm --filter @kakdela/speedy test
pnpm build
```

Services run in separate terminals. Database setup and disposable integration runners are documented in DEVELOPMENT. `pnpm build` is the JS/TS/web build; native builds require Rust and `protoc`. Windows uses NSIS, not MSI. `docker:reset` deletes dev volumes and does not restart services.

## Code map and invariants

- `ginzu`: shared Zod schemas, types, WS events and permissions. Update contracts and both consumers together.
- `speedy`: Fastify REST/WS, PostgreSQL/Redis/MinIO, LiveKit admission. Production runs TS through `tsx` because ginzu exports TS sources.
- `polly`: React/TanStack Query/Zustand/wouter. Route native calls through `src/lib/host/`; Rust belongs in `src-tauri/`.
- `francine`: migrations, seed, invites. `big-cheese`: backup only; other admin commands are placeholders.
- Persistent mutations use REST. WS accepts hello/ping/pong/typing/presence and delivers server events; the discriminator is `t`.
- PostgreSQL membership is authoritative for WS delivery and LiveKit admission. Public signaling goes through speedy `/livekit`; private SFU :7880 must not become a public bypass. Follow [audit-admission.md](audit-admission.md) for rollout.
- Pass the transaction executor through nested DB helpers; do not acquire a second global DB connection from inside a transaction.
- Current auth state lives in Zustand. `features/auth/api.ts` also persists user + access token through `lib/host/secrets.ts`; do not describe access tokens as memory-only. Never store auth tokens directly in localStorage.
- JWT storage can fall back from keychain to IndexedDB/sessionStorage. Native secret-chat DEK storage is separate and fails closed without a secure keychain; Android Keystore is unfinished.
- Use design tokens from `tokens.css` and references in `designs/`; no UI kits, Redux or moment.js.

## Changes and verification

Use the relevant task card and current source as context. Preserve historical audit evidence; add dated results rather than rewriting the original report. Distinguish code implemented, tests passed and runtime/deployment confirmed.

Conventional commits are used (`feat:`, `fix:`, `docs:`, etc.). Reference a task ID when a matching card exists. Choose checks appropriate to the actual changes; full CI is in `.github/workflows/audit-regressions.yml`.
