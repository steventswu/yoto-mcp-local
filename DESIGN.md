# YotoMCP Local Design Baseline

## Specification sources

- Yoto official SDK: `@yotoplay/yoto-sdk` 1.2.4
- Yoto API: `https://yoto.dev/api/`
- Yoto CLI authentication: Authorization Code + PKCE with a loopback callback
- Yoto API scopes: request only the scopes required by the enabled features

## Initial tool set

| Tool | Default | Yoto API / SDK | Permission |
| --- | --- | --- | --- |
| `yoto_auth_start` | Enabled | `/authorize` | No API data |
| `yoto_auth_complete` | Enabled | `/oauth/token` | `offline_access` |
| `yoto_auth_status` | Enabled | Local token metadata | No Yoto API call |
| `yoto_logout` | Enabled | Delete local token | No Yoto API call |
| `yoto_list_cards` | Enabled | `content.getMyCards()` | `user:content:view` |
| `yoto_get_card` | Enabled | `content.getCard(cardId)` | `user:content:view` |
| `yoto_list_devices` | Enabled | `devices.getMyDevices()` | `family:devices:view` |
| `yoto_create_card` | Disabled | `content.updateCard(card)` | `user:content:manage` + `confirm=true` |
| `yoto_delete_card` | Disabled | `content.deleteCard(cardId)` | `user:content:manage` + `DELETE <cardId>` |
| `yoto_upload_audio` | Disabled | Media upload URL + transcode | `user:content:manage` + `YOTO_AUDIO_ROOT` |

The initial version does not request `family:devices:control` or `family:devices:manage`, so it cannot remotely control players or change player settings.

## Threat model and controls

1. The MCP client may be affected by prompt injection: write tools are not registered by default and require confirmation parameters.
2. The MCP server may be accidentally deployed remotely: it uses stdio only and creates no HTTP listener.
3. The OAuth callback may be intercepted by another local process: a random `state`, PKCE verifier, and `127.0.0.1` binding are used.
4. A refresh token may be read locally: the token directory is 0700, the token file is 0600, and tokens are never written to logs or MCP responses.
5. Local files may be exfiltrated: uploads require `YOTO_AUDIO_ROOT`, use `realpath` to prevent symlink escapes, accept only MP3/M4A, and enforce a size limit.
6. Presigned URL redirects may leak data: only HTTPS is accepted and `redirect: 'error'` is used; upload requests do not include a Bearer token.
7. Dependency supply-chain risk: dependencies use exact versions, the lockfile is committed, installation uses `--ignore-scripts`, and `npm audit` runs before and after builds.

## Explicit non-goals

- No HTTP, Docker remote deployment, or anonymous network access.
- No multiple-account support, avoiding cross-account mistakes caused by account selectors.
- No local cache of complete cards, family-member data, or tokens.
- No automatic card creation, modification, deletion, or file upload.
- `ToolAnnotations` are not treated as authorization; they are risk hints for the MCP client.

## Extension gate

Before adding any tool, document its API endpoint, required scope, local file access, Yoto state changes, human-confirmation method, input limits, whether output contains personal data, and corresponding tests. Device control and card updates should use a two-stage preview/commit flow instead of allowing the model to submit a complete payload directly.
