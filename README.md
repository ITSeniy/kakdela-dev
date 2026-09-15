# pizza-parlor · КакДела

Self-hosted chat for a small group of friends: text channels, direct messages, voice, video and screen sharing. Windows desktop via Tauri 2, a browser client, and an Android client under development.

Portfolio project by Arseniy Makhonin. [Русская версия](README.ru.md).

## Current state

The code extends beyond the original MVP. Recent work focuses on access revocation, LiveKit admission and reliability. The security audit is partially resolved; Android secret chats require Keystore support, attachment URLs remain public, and deployment of the admission gateway has not been confirmed. See [current work](.claude/CURRENT_PHASE.md) and [audit status](audit-fixes.md).

## Development

Use **Node.js 24** (`.nvmrc`: 24.20.0) and **pnpm 9.12.0**. Docker Compose is required for the local services. Desktop builds also require Rust, `protoc`, C++ build tools and WebView2 on Windows.

```sh
pnpm install --frozen-lockfile
```

Follow [local setup](docs/DEVELOPMENT.md) to configure the environment, start services, migrate the database and create the first invite. Then run backend and client in separate terminals:

```sh
pnpm dev:speedy
pnpm dev:web
```

Use `pnpm dev:polly` for the desktop window. Verification:

```sh
pnpm typecheck
pnpm lint
pnpm --filter @kakdela/speedy test
pnpm build
```

`pnpm build` builds the backend TypeScript and web client. The Windows NSIS installer is built with `pnpm --filter @kakdela/polly tauri:build`. Integration tests have [separate disposable runners](docs/DEVELOPMENT.md).

## Repository

| Package | Role |
|---|---|
| `packages/speedy` | Fastify API, WebSocket gateway and LiveKit admission |
| `packages/polly` | React client and Tauri/Rust native code |
| `packages/ginzu` | Shared schemas, types, events and permissions |
| `packages/francine` | Migrations, seed and invite CLI |
| `packages/big-cheese` | Backup CLI; other admin commands are placeholders |

PostgreSQL stores application data, Redis handles temporary state and events, MinIO stores files, and LiveKit carries WebRTC media. Infrastructure and test runners live in `ops/`.

## Documentation

[Documentation index](docs/README.md) · [Architecture](ARCHITECTURE.md) · [Deployment](docs/DEPLOY.md) · [Android](docs/MOBILE.md) · [Backups](ops/backup/README.md) · [Task cards](tasks/README.md)

Local secrets, build outputs and raw audit evidence are excluded from Git. Android platform sources under `src-tauri/gen/android` are tracked intentionally.

## License

Original source code: [MIT](LICENSE). Third-party dependencies retain their own licenses.
