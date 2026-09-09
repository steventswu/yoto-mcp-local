# YotoMCP Local

安全取向的 Yoto MCP 初版，使用 Yoto 官方 TypeScript SDK 與官方 OAuth Authorization Code + PKCE 流程。

## 安全設計

- 僅支援 MCP stdio，不提供 HTTP listener。
- 登入 callback 僅綁定 `127.0.0.1`，並驗證 OAuth `state` 與 PKCE verifier。
- token 存於本機檔案，目錄 0700、檔案 0600；工具永不回傳 token。
- 預設只啟用讀取工具。
- 寫入操作必須設定 `YOTO_ENABLE_WRITES=true`。
- 上傳工具還必須設定 `YOTO_AUDIO_ROOT`，並拒絕 symlink 跳出根目錄、非 MP3/M4A 與超大檔案。
- 上傳 presigned URL 強制 HTTPS、禁止 redirect，且不附加 Bearer token。
- 不支援多帳號，降低誤操作與權限混淆的 blast radius。

## 建置

需要 Node 20+，並先在 Yoto Developer Dashboard 建立 Public Client，註冊：

`http://127.0.0.1:8787/callback`

```sh
npm install --ignore-scripts
npm run typecheck
npm run build
```

## 啟動

```sh
YOTO_CLIENT_ID='your-public-client-id' node dist/index.js
```

啟動後透過 `yoto_auth_start` 取得登入網址，瀏覽器完成登入後呼叫 `yoto_auth_complete`。

要啟用寫入與音訊上傳：

```sh
YOTO_CLIENT_ID='your-public-client-id' \
YOTO_ENABLE_WRITES=true \
YOTO_AUDIO_ROOT="$HOME/YotoAudio" \
node dist/index.js
```

正式使用前仍應以測試帳號、測試卡片與獨立音訊目錄驗證；不要把 client secret、access token 或 refresh token 放進設定檔、repository、MCP 訊息或 log。
