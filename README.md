# Kladde

**An encrypted, local-first notebook for macOS and iPhone.**

Pages, databases, attachments and the full-text index are stored encrypted on the device. Your own devices can optionally sync through a self-hosted relay that only ever sees encrypted data.

Currently supported: macOS, iOS 

Planned: Windows, Android

## Features

- **Notebooks**: create, rename and delete them under **Manage notebooks**
- **Pages & editor**: blocks, `/` menu, formatting bar, history and versioning
- **Databases**: views with AND/OR filter groups, multi-key sorting and automations
- **Full-text search** (`⌘P`), including PDFs, scans, images and Office files, with on-device text recognition
- **Find in page** (`⌘F`), with every match highlighted, also inside a PDF or image in the viewer
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

## How the encryption works

Kladde works fully offline. Sync is optional, and the relay server is treated as untrusted: it stores and forwards data, but it can neither read it nor change it unnoticed. All cryptography lives in [`crates/kladde-crypto`](crates/kladde-crypto), account and key handling in [`crates/kladde-sync/src/account`](crates/kladde-sync/src/account).

### Primitives

| Purpose | Algorithm |
| --- | --- |
| Symmetric encryption | XChaCha20-Poly1305 (192-bit random nonces), STREAM construction for large files |
| Key derivation | HKDF-SHA256 with a separate label per purpose (`kladde/v1/doc`, `kladde/v1/file`, …) |
| Signatures | Ed25519 (strict verification) |
| Password login | OPAQUE (Ristretto255, 3DH, SHA-512) |
| Password hashing | Argon2id, 64 MiB, 3 iterations, 1 lane |
| Recovery phrase | BIP39, 24 words (256 bits) |
| Local database | SQLCipher |

Secrets are kept in zeroizing buffers and wiped from memory after use.

### On the device

- **Notebook database:** everything (pages, databases, versions, search index, sync state, the account keys) lives in a SQLCipher database. Its 256-bit key is generated randomly on first launch and stored in the Keychain. On the iPhone and in signed Mac builds it is marked "accessible when unlocked, this device only", so it never ends up in iCloud or device backups.
- **Attachments:** every file gets its own random 256-bit key and is encrypted in 64 KiB chunks (XChaCha20-Poly1305 STREAM). Truncating, reordering or swapping chunks makes decryption fail.
- **Quick capture inbox:** web clips and shared items that arrive while the app is closed are encrypted with a separate Keychain key and written with `0600` permissions until the app imports them.
- **Encrypted backups:** exported backups are encrypted with a key derived from a backup password (at least 12 characters) via Argon2id and a random salt. The file header is authenticated, so a backup cannot be relabelled for a different notebook.

### Account keys

Creating an account generates these keys on the device:

```
password ──OPAQUE──▶ export key ─┐
                                 ├─wraps─▶ master key ─wraps─▶ identity key (Ed25519)
recovery phrase (24 words) ──────┘                     └─────▶ workspace key sets
```

- **Password:** Kladde uses OPAQUE, so the password never leaves the device, not even as a hash. The server stores an OPAQUE record that it cannot use to log in itself. Guessing the password offline would require both a copy of the database and the server's OPAQUE key, and each guess still costs a full Argon2id run. The login also yields an *export key* that only the client knows.
- **Recovery phrase:** 24 random words, shown once when you create the account. The app asks you to confirm two of them. They are a second, independent way to unlock the master key.
- **Master key:** random, encrypted twice: once with the export key, once with the recovery phrase. The server only stores these encrypted copies.
- **Identity key:** signs device certificates. Its public half is stored on the server and must match the decrypted private key, otherwise login fails.

Every wrapped key is bound to its account or workspace ID and purpose as additional authenticated data. The server cannot move a key from one slot to another or hand you a key that belongs to a different account.

If you lose **both** the password and the recovery phrase, the data on the server cannot be decrypted by anyone. The copy on your devices stays readable.

### Workspaces, pages and updates

- Each workspace has a **key set**: a list of epochs, each consisting of a random 256-bit key and the public identity key that was valid at the time. New content is always encrypted with the latest epoch. Older epochs are kept so the history stays readable.
- Each page gets its own key, derived with HKDF from the epoch key and the page ID.
- Every change is sent as a signed **envelope**:
  - The content is padded with the Padmé scheme before encryption, so the server only learns approximate sizes.
  - The header (workspace, page, epoch, device, counter, hash of the previous envelope, nonce) is authenticated as additional data.
  - Header and ciphertext are signed by the device key.
- When receiving an envelope, the app checks the device certificate against the identity key, the signature, the expected workspace, page and epoch, the per-device counter and the hash chain. A server cannot forge, replay, reorder, drop single updates from the middle of a chain or move them to another page without the app noticing.
- Attachments uploaded to the relay contain the encrypted file plus its file key, encrypted with the page key. Shared page versions are stored the same way.
- The page lists the SHA-256 of every attachment part and shared version in its own signed content. A download has to match that hash before it is stored, shown or indexed, so replacing an attachment requires a device that can sign page changes; the workspace keys of a removed device are not enough. A download that neither the page nor its local history lists is refused. Files attached with version 1.1.0 or earlier carry no hash and are still accepted without one.
- Text a device recognizes in an attachment (OCR, PDF and Office text) is uploaded as an extra encrypted attachment, so your other devices can search the file without downloading and recognizing it again. It is signed by the device key and carries the device certificate. Other devices only accept it if the certificate is valid for the current identity key and the signature covers this workspace, page, file and epoch; otherwise they recognize the text themselves. After a key rotation, devices upload their texts again under the new identity. Its ID is derived from the workspace key, so the relay cannot link it to the file by its ID.
- Deleting a page sends a request signed by the device key. The relay keeps that signature and passes it on with the deletion. Other devices only remove their copy if the signature comes from a device whose certificate is valid for the current identity key. A deletion the relay reports without such a signature is ignored: the page stays on the device and simply no longer syncs. This covers deletions from an older relay version and deletions signed before the last key rotation.
- A notebook can be removed from the relay on its own. The request has to be signed by a device key, like deleting pages and attachments, so a stolen session token is not enough. The relay then deletes the notebook's pages, history and attachments and frees their storage. The notebook the account was created with stays, because its key set is part of the account keys. Devices that still have the notebook keep their copy: their next sync is refused, and they show the notebook as one that only exists on that device. Uploading it again creates a new key set; every device then drops its sync state from before and merges its copy anew.

### Devices and sessions

- Every device generates its own Ed25519 key. The account's identity key signs a certificate for it at sign-in.
- The server issues a session token valid for 24 hours. It only stores a SHA-256 hash of the token. Devices renew their session by signing a fresh challenge with their device key.
- Login attempts are rate limited per username, and with `TRUST_FORWARDED_FOR=1` additionally per client IP.

### Changing the password, recovery and removing devices

Changing the password, recovering with the phrase or removing a device triggers a full key rotation on the device:

1. A new master key, identity key and recovery phrase are generated.
2. Every workspace key set gets a new epoch with a fresh key. A key set holds up to 1024 epochs, so an account can rotate its keys more than a thousand times.
3. For every notebook, the device signs a **closing list** with the new identity key. For devices whose certificate it verifies against the current identity, it takes the last entry of their chain as the relay reports it. For older chains, it takes over exactly the entries of the closing lists that are valid now, never more, so the relay cannot slip in what a device removed earlier wrote after its removal.
4. The new key material and the closing lists are uploaded in a single signed request. The relay refuses it if a notebook changed after the chains were read; the device then starts over.
5. The server marks all devices as revoked and deletes all sessions.

The old phrase stops working and every device has to sign in again. When a device that already knows the account signs in again, it checks that the new key sets continue the old ones. A server that tries to swap in keys of its own is rejected. Until the server has confirmed a rotation, sync stays paused.

After a rotation, an entry certified under an earlier identity key is only accepted if its chain ends exactly at an entry on a closing list signed by the current identity. A removed device still knows the old identity key, but it cannot add anything to the history, not even together with the relay. Everything written before the rotation stays readable, also on a device that signs in for the first time, for example after recovering with the phrase. Devices that were already signed in before closing lists existed sign the chain ends they have verified themselves once with their device key, so history from earlier rotations that one of your devices already had stays readable as well. History that only the relay holds and that no updated device ever had is not taken over.

### What the relay can see

The relay **cannot** see page content, titles, database entries, file names, attachments, search terms or the local search index.

To work, it **does** see: your username and IP address, public keys, device, workspace, page and file IDs, approximate sizes, when and how often something changes, and how much storage an account uses. When you remove a notebook from the server, the relay deletes what it stored for it, but it sees which workspace ID was removed and when. A notebook that is uploaded again keeps its ID, so the relay can tell it is the same one.

## Self-hosting the relay server

You only need a relay if you want to sync between devices. One relay can serve any number of accounts.

### Requirements

- A Linux server with Docker and the Docker Compose plugin. A small VPS is enough.
- A domain or subdomain (for example `sync.example.org`) whose A/AAAA record points to the server.
- Ports 80 and 443 reachable from the internet. Caddy uses them to obtain and renew the Let's Encrypt certificate automatically.

The app only connects to `https://` addresses, so a valid certificate is required.

### Setup

There is no prebuilt image, so you build it yourself from the repository root:

```sh
git clone https://github.com/ldeutschland/kladde.git
cd kladde
docker build -f deploy/Dockerfile -t kladde-relay .
```

Create the configuration:

```sh
cd deploy
cp .env.example .env
```

Set your domain in `.env` and generate the database password:

```sh
sed -i "s/^DOMAIN=.*/DOMAIN=sync.example.org/" .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
chmod 600 .env
```

Use a hex password like this one: it ends up in the database URL, where special characters would break the connection.

Generate the OPAQUE server key, once:

```sh
docker compose run --rm --no-deps setup
```

It is written to `/data/opaque.setup` in the `data` volume, with no network access during generation. The step refuses to overwrite an existing key. **Never regenerate it on a running relay:** all existing accounts would no longer be able to log in.

Start everything:

```sh
docker compose up -d
curl -i https://sync.example.org/health
```

The health check responds with `204 No Content`. The database schema is created automatically on first start.

### What the Compose setup runs

| Service | Role |
| --- | --- |
| `caddy` | TLS termination and reverse proxy, the only service with public ports (80, 443) |
| `relay` | The Kladde server, read-only file system, no capabilities, `no-new-privileges`, runs as an unprivileged user |
| `postgres` | Accounts, encrypted key bundles, encrypted updates. Only reachable on an internal network without internet access |
| `setup` | One-off job that generates the OPAQUE key |

Attachments are stored as files in the `data` volume (`/data/blobs`), everything else in PostgreSQL.

### Connecting the app

1. Open registration for the accounts you want to create, see [Registration](#registration).
2. In Kladde, open **Connect to sync server**.
3. Enter `https://sync.example.org` as the server address.
4. On the first device, choose **Create account**, pick a username (3 to 64 characters: letters, digits, `.`, `_`, `-`) and a password of at least 12 characters.
5. Write down the recovery phrase and keep it somewhere safe and offline. It is shown only once.
6. On every other device, choose **Sign in** with the same server, username and password.
7. Under **Sync → Notebooks**, choose what each device syncs. Notebooks on the server sync to every signed-in device, also while they are not open, unless you switch them off on that device; nothing is deleted when you do. A notebook that only exists on one device is uploaded once you switch it on there. **Remove from server** (the crossed-out cloud next to a notebook) deletes a notebook from the server; the copies on your devices stay and simply stop syncing. The notebook you created the account with stays on the server. Deleting a notebook under **Manage notebooks** can remove it from the server as well; if it stays there, this device switches it off so it does not download again.

### Configuration

Variables in `deploy/.env`:

| Variable | Meaning |
| --- | --- |
| `DOMAIN` | Hostname of the relay, used by Caddy for the certificate |
| `POSTGRES_PASSWORD` | Password of the PostgreSQL user `kladde` |
| `OPEN_REGISTRATION` | `1` lets new accounts register, `0` refuses them (default) |

Variables of the `relay` service (set in `docker-compose.yml`, defaults come from the image):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | set by Compose | PostgreSQL connection string |
| `LISTEN_ADDR` | `0.0.0.0:7341` in the image, `127.0.0.1:7341` otherwise | Address the server listens on |
| `BLOB_DIR` | `/data/blobs` | Directory for encrypted attachments |
| `OPAQUE_SETUP_FILE` | `/data/opaque.setup` | OPAQUE server key |
| `TRUST_FORWARDED_FOR` | `0` (`1` in Compose) | Use the last `X-Forwarded-For` entry as client IP for rate limiting. Only set to `1` behind a proxy that overwrites this header, like the included Caddy config |
| `ACCOUNT_QUOTA_BYTES` | unlimited | Storage limit per account, at least `1048576` |
| `OPEN_REGISTRATION` | `0` (from `.env` in Compose) | `1` allows creating new accounts. Logins, recovery and sync work either way |

To set a quota of 5 GiB, add it to the `environment` of the `relay` service:

```yaml
ACCOUNT_QUOTA_BYTES: "5368709120"
```

### Registration

The relay refuses new accounts unless registration is open, including the very first one. To create accounts, set `OPEN_REGISTRATION=1` in `.env` and apply it:

```sh
sed -i "s/^OPEN_REGISTRATION=.*/OPEN_REGISTRATION=1/" .env
docker compose up -d
```

Create the accounts in the app, then close registration again the same way with `OPEN_REGISTRATION=0`. Logins, recovery and sync keep working while registration is closed. Anyone who can reach the server can register while it is open, and the storage quota is unlimited unless you set `ACCOUNT_QUOTA_BYTES`, so keep it open only as long as you need it.

### Backups

A complete backup consists of three things that belong together:

- the PostgreSQL database
- the `data` volume (attachments **and** `opaque.setup`)
- your `.env`

Without `opaque.setup`, nobody can log in after a restore. The data is end-to-end encrypted, but `opaque.setup` is the server's private key, so keep backups private.

Stop the relay briefly so the database and attachments match:

```sh
docker compose stop relay
docker compose exec -T postgres pg_dump -U kladde -Fc kladde > kladde.dump
docker run --rm -v deploy_data:/data:ro -v "$PWD":/backup debian:bookworm-slim tar czf /backup/kladde-data.tar.gz -C /data .
docker compose start relay
```

Compose prefixes volumes with the project name, which defaults to the directory name (`deploy`). Check with `docker volume ls` if yours differ.

Your devices keep a full copy of their data, so the relay is not your only copy. After restoring an older server state, run **Repair sync** in the app on every device. It uploads what the server is missing.

### Updating

```sh
git pull
docker build -f deploy/Dockerfile -t kladde-relay .
cd deploy
docker compose up -d
```

Database migrations run automatically at startup. If the app and the relay are too far apart in version, the app reports it and keeps your changes locally until both are updated. Update the relay together with the app: deleted pages only reach your other devices through a relay that passes on the deletion signatures, and history from before a key change only stays readable through a relay that stores closing lists.

### Running without Docker

You can also run the server behind your own TLS reverse proxy:

```sh
cargo build --release --locked -p kladde-server
./target/release/kladde-server init-setup /var/lib/kladde/opaque.setup
DATABASE_URL=postgresql://kladde:…@localhost/kladde \
BLOB_DIR=/var/lib/kladde/blobs \
OPAQUE_SETUP_FILE=/var/lib/kladde/opaque.setup \
./target/release/kladde-server
```

It listens on `127.0.0.1:7341` by default and needs PostgreSQL. The proxy must terminate HTTPS and support WebSockets (`/v1/sync`). Only set `TRUST_FORWARDED_FOR=1` if the proxy replaces `X-Forwarded-For` with the real client IP. Otherwise clients could choose their own IP for rate limiting. Start it with `OPEN_REGISTRATION=1` while you create accounts. Allow it enough open files, for example `ulimit -n 65536`: every connection, sync socket and attachment transfer holds one or two.

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

## Tests

```sh
pnpm lint && pnpm test
pnpm exec playwright install webkit && pnpm e2e
cargo test --locked --workspace
```

## License

[AGPL-3.0](LICENSE)
