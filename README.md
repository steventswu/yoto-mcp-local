# YotoMCP Local

A security-focused local Yoto MCP server using Yoto's official TypeScript SDK and the official OAuth Authorization Code + PKCE flow.

## Security design

- MCP stdio only; no HTTP listener is exposed.
- The login callback binds only to `127.0.0.1` and validates the OAuth `state` and PKCE verifier.
- Tokens are stored locally with a 0700 directory and 0600 file; tools never return tokens.
- Read-only tools are enabled by default.
- Write operations require `YOTO_ENABLE_WRITES=true`.
- Uploads additionally require `YOTO_AUDIO_ROOT`, reject symlink escapes, accept only MP3/M4A files, and enforce a size limit.
- Presigned uploads require HTTPS, reject redirects, and never attach a Bearer token.
- Multiple accounts are not supported, reducing accidental cross-account operations.

## Build

Node 20+ is required. First create a Public Client in the Yoto Developer Dashboard and register:

`http://127.0.0.1:8787/callback`

```sh
npm install --ignore-scripts
npm run typecheck
npm run build
```

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
node dist/index.js
```

Before production use, validate with a test account, test cards, and a dedicated audio directory. Never place a client secret, access token, or refresh token in configuration files, the repository, MCP messages, or logs.
