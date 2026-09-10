# YotoMCP Local

A security-focused local Yoto MCP server using Yoto's official TypeScript SDK and the official OAuth Authorization Code + PKCE flow.

## 0.2.0

This release adds resumable operations, job manifests, card fingerprints and
dry-run previews, bounded background progress, and deterministic resolution of
existing Yoto user/public icons. It does not upload generated images.

## Security design

- MCP stdio only; no HTTP listener is exposed.
- The login callback binds only to `127.0.0.1` and validates the OAuth `state` and PKCE verifier.
- Tokens are stored locally with a 0700 directory and 0600 file; tools never return tokens.
- Read-only tools are enabled by default.
- Write operations require `YOTO_ENABLE_WRITES=true`.
- Uploads additionally require `YOTO_AUDIO_ROOT`, reject symlink escapes, accept only MP3/M4A files, and enforce a size limit.
- Icon resolution reads existing Yoto user/public catalogs; it does not upload icon files.
- Card updates verify expected snapshots and read back the resulting audio/icon references.
- Presigned uploads require HTTPS, reject redirects, and never attach a Bearer token.
- Multiple accounts are not supported, reducing accidental cross-account operations.

## Available Tools

| Tool name | Description |
| --- | --- |
| `yoto_auth_start` | Start the local Yoto Authorization Code + PKCE login flow and return the browser URL. |
| `yoto_auth_complete` | Complete the pending PKCE login after the browser redirects to the local callback. |
| `yoto_auth_status` | Show local authentication status without returning tokens. |
| `yoto_logout` | Delete the locally stored Yoto token record without calling a remote API. |
| `yoto_list_cards` | List the authenticated user's MYO cards. Read-only. |
| `yoto_get_card` | Retrieve one MYO card by ID. Read-only. |
| `yoto_list_devices` | List linked Yoto players and their status. Does not control or modify devices. |
| `yoto_create_card` | Create an empty MYO card. Disabled by default; requires `YOTO_ENABLE_WRITES=true` and `confirm=true`. |
| `yoto_delete_card` | Permanently delete an MYO card. Disabled by default; requires `YOTO_ENABLE_WRITES=true` and exact confirmation text. |
| `yoto_upload_audio` | Upload an MP3/M4A file from `YOTO_AUDIO_ROOT` and wait for transcoding. Disabled by default; requires `YOTO_ENABLE_WRITES=true`. |
| `yoto_create_playlist_from_files` | Create a playlist from local audio and resolve existing Yoto icons by title. |
| `yoto_append_playlist_from_files` | Start a resumable append operation and return an `operationId`. |
| `yoto_get_operation` | Read background operation progress and per-track status. |
| `yoto_cancel_operation` | Request cancellation of a background operation. |
| `yoto_get_job_manifest` | Read a local resumable job manifest. |
| `yoto_truncate_playlist` | Destructively remove chapters after an expected count with exact confirmation and readback. |

## Build

Node 20+ is required. First create a Public Client in the Yoto Developer Dashboard and register:

`http://127.0.0.1:8787/callback`

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
```

## Test

Run the offline test suite and dependency audit:

```sh
npm run check
```

The tests do not authenticate with Yoto or call the Yoto API. They cover safe configuration defaults, conditional write-tool exposure, delete confirmation, token-file permissions and removal, and audio path restrictions.

## Run

```sh
YOTO_CLIENT_ID='your-public-client-id' node dist/index.js
```

After startup, call `yoto_auth_start` to receive the login URL. Complete login in the browser, then call `yoto_auth_complete`.

To enable writes and audio uploads:

```sh
YOTO_CLIENT_ID='your-public-client-id' \
YOTO_ENABLE_WRITES=true \
YOTO_AUDIO_ROOT="$HOME/YotoAudio" \
YOTO_MANIFEST_ROOT="$HOME/YotoJobs" \
node dist/index.js
```

When writes are enabled, the OAuth client must allow `user:content:view`,
`user:content:manage`, `user:icons:manage`, `family:devices:view`, and
`offline_access`. Existing tokens may require a new OAuth consent after scope
changes.

Before production use, validate with a test account, test cards, and a dedicated audio directory. Never place a client secret, access token, or refresh token in configuration files, the repository, MCP messages, or logs.
