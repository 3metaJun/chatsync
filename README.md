# ChatSync for OpenRouter

A browser extension (Chrome / Edge / Firefox) that syncs your [OpenRouter](https://openrouter.ai/chat) chat history across devices and browsers.

OpenRouter's chat playground is local-first: conversations live in your browser's IndexedDB with no server-side sync, and the only official tools are manual Export/Import JSON. ChatSync automates that: it watches the local database and merges every room into a remote backend you own, so any device pointing at the same backend converges to the same chat list.

## How it works

```
openrouter.ai (content script)          your storage backend
┌──────────────────────────┐            ┌────────────────────────┐
│ IndexedDB                │  push /   │ manifest.json          │
│  openrouter:playground:v3│  pull     │ rooms/<roomId>.json    │
└──────────────────────────┘            └────────────────────────┘
        ▲ service worker (diff / merge / alarms)
```

- **Format**: each room is serialized as `orpg.3.0` JSON, byte-compatible with OpenRouter's official Export. Files in the sync root can be imported by hand at any time.
- **Merging**: per-room content hash against a remote manifest. Rooms are matched by their OpenRouter-issued ids; conflicting edits resolve last-write-wins by `room.updatedAt`.
- **Deletions**: propagate in both directions via tombstones. Deleting a chat on one device removes it everywhere on the next sync; a remotely-deleted room that was edited locally afterwards is resurrected instead of lost. A fresh/empty remote never deletes local data.
- **Application**: pulled rooms are upserted into IndexedDB by id (idempotent, same semantics as the official Import) and the openrouter.ai tab reloads to show them.
- **Size**: optional "strip model catalog snapshots" mode drops `characters[].modelInfo` (typically ~90% of payload). Base64 images inside items are synced as-is.

## Backends

| Backend | Auth | Notes |
|---|---|---|
| GitHub repo | Fine-grained PAT (Contents read/write) | Every changed room is its own commit, so you get full history and rollback via git. |
| WebDAV | Basic auth | Works with Nextcloud, nutstore, Synology, or a self-hosted server. |

## Install (development)

```bash
pnpm install
pnpm zip:all                    # chrome + edge + firefox zips in .output/
pnpm test                       # sync engine unit tests
```

Then load the unpacked build (`.output/chrome-mv3`, `.output/edge-mv3`, or `.output/firefox-mv3`):

- **Chrome / Edge** (desktop): `chrome://extensions` (or `edge://extensions`) → enable Developer mode → Load unpacked
- **Firefox 128+** (desktop): `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `.output/firefox-mv3/manifest.json`, or install the signed zip from releases
- **Firefox Android 128+**: install from [addons.mozilla.org](https://addons.mozilla.org) once published (the same package as desktop). During development: enable USB debugging on the phone, connect `adb`, then `npx web-ext run -t firefox-android -s .output/firefox-mv3`

Grab prebuilt zips from [releases](https://github.com/3metaJun/chatsync/releases).

> Android notes: Edge/Chrome on Android have no third-party extension runtime, so Firefox Android is the only supported mobile target. Sync opens an openrouter.ai tab in the foreground for a few seconds while it runs; local `127.0.0.1` WebDAV URLs point at the phone itself, so use a LAN/hosted WebDAV URL instead.

## Usage

1. Open the extension options and configure a backend (GitHub token + repo, or WebDAV URL + credentials).
2. Click **save & test connection**.
3. Open https://openrouter.ai/chat, click the ChatSync icon, and hit **sync now**. Optionally set an auto-sync interval (minutes) in options.

Syncing requires an openrouter.ai tab (the extension opens one in the background automatically if none exists, and closes it when done).

## Project layout

```
src/
├── entrypoints/
│   ├── background.ts      # sync orchestration, tab bridging, alarms
│   ├── content.ts         # IndexedDB bridge on openrouter.ai
│   ├── popup/             # status + manual sync
│   └── options/           # backend configuration
└── lib/
    ├── types.ts           # orpg.3.0 + sync manifest models (from live recon)
    ├── orpg.ts            # export assembly / import planning / hashing
    ├── playground-db.ts   # IndexedDB read / upsert / delete
    ├── sync-engine.ts     # pure diff/merge engine (+ unit tests)
    └── adapters/          # github, webdav
```

## Privacy

Chat content only ever travels between your browser and the backend you configure. Credentials are stored in `chrome.storage.local`. No telemetry.

## License

MIT
