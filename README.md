# Kladde

**An encrypted, local-first notebook for macOS and iPhone.**

Pages, databases, attachments and the full-text index are stored encrypted on the device. Your own devices can optionally sync through a self-hosted relay that only ever sees encrypted data.

## Features

- **Pages & editor**: blocks, `/` menu, formatting bar, history and versioning
- **Databases**: views with AND/OR filter groups, multi-key sorting, summaries and automations
- **Full-text search** (`⌘P`), including PDFs, scans, images and Office files, with on-device text recognition
- **Attachments**, with a viewer and editing for images and PDFs
- **Quick notes & web clips**: global `⌘⌥⇧N` on the Mac, "Share → Kladde" on the iPhone, plus a browser extension
- **Audio notes** with on-device transcription
- **End-to-end encrypted sync** between your own devices
- **Optional AI agent** via OpenRouter, off by default

## Structure

| Path | Contents |
| --- | --- |
| `apps/kladde` | Tauri app: React renderer and Rust core |
| `crates/` | Cryptography, storage (SQLCipher), sync protocol, AI and web clips |
| `server/` | Relay server (Rust, PostgreSQL) |
| `deploy/` | Dockerfile, Compose setup and Caddy |

## Building the app

**Requirements:** macOS with Xcode, Node 24+, pnpm 11.25.0 and Rust via rustup.

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

**macOS app** (signed with your own identity):

```sh
APPLE_SIGNING_IDENTITY="Apple Development: Name (TEAMID)" sh scripts/build-macos-local.sh
open target/release/bundle/macos/Kladde.app
```

**iPhone:** set your own development team in Xcode first.

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
pnpm tauri ios run --release --open
```

## Installing the relay server

You need a server with Docker and a domain pointing to it. Caddy obtains the HTTPS certificate automatically.

```sh
docker build -f deploy/Dockerfile -t kladde-relay .
cd deploy
cp .env.example .env
docker compose run --rm --no-deps setup
docker compose up -d
```

Set `DOMAIN` and a long `POSTGRES_PASSWORD` in `.env`. The `setup` step generates the OPAQUE server key once. Back it up together with the database: without it, nobody can log in. Only ports 80 and 443 are exposed. `GET /health` responds with `204`.

Optionally, `ACCOUNT_QUOTA_BYTES` in the `environment` of the `relay` service limits storage per account (at least `1048576`). Registration is open, so keep an eye on disk space or restrict access at the proxy.

## Tests

```sh
pnpm lint && pnpm test
pnpm exec playwright install webkit && pnpm e2e
cargo test --locked --workspace
```

## License

[AGPL-3.0](LICENSE)
