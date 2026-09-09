import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface Config {
  clientId: string;
  authDomain: string;
  audience: string;
  redirectPort: number;
  tokenFile: string;
  enableWrites: boolean;
  audioRoot?: string;
  maxUploadBytes: number;
}

function positivePort(value: string | undefined): number {
  const port = Number(value ?? '8787');
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8787;
}

function positiveUploadLimit(value: string | undefined): number {
  const limit = Number(value ?? 100 * 1024 * 1024);
  return Number.isSafeInteger(limit) && limit > 0 && limit <= 500 * 1024 * 1024
    ? limit
    : 100 * 1024 * 1024;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.YOTO_CLIENT_ID) {
    throw new Error('YOTO_CLIENT_ID is required. Create a Public Client in dashboard.yoto.dev.');
  }

  const tokenFile = env.YOTO_TOKEN_FILE ?? resolve(homedir(), '.config/yoto-mcp-local/tokens.json');
  const audioRoot = env.YOTO_AUDIO_ROOT ? resolve(env.YOTO_AUDIO_ROOT) : undefined;

  return {
    clientId: env.YOTO_CLIENT_ID,
    authDomain: env.YOTO_AUTH_DOMAIN ?? 'login.yotoplay.com',
    audience: env.YOTO_AUDIENCE ?? 'https://api.yotoplay.com',
    redirectPort: positivePort(env.YOTO_REDIRECT_PORT),
    tokenFile: resolve(tokenFile.replace(/^~(?=\/)/, homedir())),
    enableWrites: env.YOTO_ENABLE_WRITES === 'true',
    audioRoot,
    maxUploadBytes: positiveUploadLimit(env.YOTO_MAX_UPLOAD_BYTES),
  };
}
