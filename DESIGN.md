# YotoMCP Local 設計基準

## 規格來源

- Yoto 官方 SDK：`@yotoplay/yoto-sdk` 1.2.4
- Yoto API：`https://yoto.dev/api/`
- Yoto CLI authentication：Authorization Code + PKCE，loopback callback
- Yoto API scopes：只請求實際功能需要的 scope

## 第一版工具

| Tool | 預設 | Yoto API / SDK | 權限 |
| --- | --- | --- | ---
| `yoto_auth_start` | 開啟 | `/authorize` | 無 API data
| `yoto_auth_complete` | 開啟 | `/oauth/token`, `/userinfo` | `offline_access`, `profile`
| `yoto_auth_status` | 開啟 | 本機 token metadata | 無 Yoto API call
| `yoto_logout` | 開啟 | 本機刪除 token | 無 Yoto API call
| `yoto_list_cards` | 開啟 | `content.getMyCards()` | `user:content:view`
| `yoto_get_card` | 開啟 | `content.getCard(cardId)` | `user:content:view`
| `yoto_list_devices` | 開啟 | `devices.getMyDevices()` | `family:devices:view`
| `yoto_create_card` | 關閉 | `content.updateCard(card)` | `user:content:manage` + `confirm=true`
| `yoto_delete_card` | 關閉 | `content.deleteCard(cardId)` | `user:content:manage` + `DELETE <cardId>`
| `yoto_upload_audio` | 關閉 | media upload URL + transcode | `user:content:manage` + `YOTO_AUDIO_ROOT`

第一版不註冊 `family:devices:control` 或 `family:devices:manage`，因此不會遠端控制或修改播放器設定。

## 威脅模型與控制

1. MCP client 可能受到 prompt injection 影響：寫入工具預設不註冊，並要求確認參數。
2. MCP server 可能被誤設為遠端服務：只使用 stdio，不建立 HTTP listener。
3. OAuth callback 被本機其他程序攔截：使用隨機 `state`、PKCE verifier，且 callback 只綁定 `127.0.0.1`。
4. refresh token 遭本機讀取：token 目錄 0700、token 檔案 0600，不將 token 寫入 log 或 MCP response。
5. 任意本機檔案外傳：上傳必須設定 `YOTO_AUDIO_ROOT`，使用 `realpath` 防止 symlink escape，只接受 MP3/M4A，並有大小上限。
6. presigned URL redirect 風險：只接受 HTTPS 並設定 `redirect: 'error'`；上傳 request 不附帶 Bearer token。
7. 第三方套件供應鏈：依賴使用 exact version、提交 lockfile、安裝時使用 `--ignore-scripts`，建置前後執行 `npm audit`。

## 明確不做

- 不支援 HTTP、Docker remote deployment 或匿名網路存取。
- 不支援多帳號，避免 account selector 造成跨帳號誤操作。
- 不把完整卡片、家庭成員資料或 token 寫入本機快取。
- 不自動建立、修改、刪除卡片，也不自動上傳檔案。
- 不把 `ToolAnnotations` 當作真正的授權機制；它們只是給 MCP client 的風險提示。

## 擴充門檻

任何新增工具都必須先列出：API endpoint、所需 scope、是否讀本機檔案、是否改變 Yoto 狀態、人工確認方式、輸入限制、輸出是否含個資，以及對應測試。裝置控制與卡片更新應優先採兩階段 preview/commit，而不是讓模型直接提交完整 payload。
