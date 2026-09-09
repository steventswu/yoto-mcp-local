import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { createYotoSdk, type YotoSdk } from '@yotoplay/yoto-sdk';
import type { Config } from './config.js';
import { AuthManager } from './auth.js';

export class YotoClient {
  constructor(private readonly config: Config, private readonly auth: AuthManager) {}

  async sdk(): Promise<YotoSdk> {
    return createYotoSdk({ jwt: await this.auth.accessToken() });
  }

  async uploadAudio(filePath: string): Promise<unknown> {
    if (!this.config.audioRoot) throw new Error('YOTO_AUDIO_ROOT is required before enabling audio upload.');
    const root = await realpath(this.config.audioRoot);
    const candidate = await realpath(resolve(filePath));
    const rel = relative(root, candidate);
    if (!rel || rel.startsWith('..') || rel.split('/').includes('..')) {
      throw new Error('filePath must stay inside YOTO_AUDIO_ROOT.');
    }
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('filePath must be a regular file.');
    if (!['.mp3', '.m4a'].includes(candidate.toLowerCase().slice(candidate.lastIndexOf('.')))) {
      throw new Error('Only .mp3 and .m4a files are allowed.');
    }
    if (info.size > this.config.maxUploadBytes) throw new Error('Audio file exceeds the configured size limit.');

    const data = await readFile(candidate);
    const sdk = await this.sdk();
    const hash = createHash('sha256').update(data).digest('hex');
    const upload = await sdk.media.getUploadUrlForTranscode(hash, basename(candidate));
    if (upload.uploadUrl) {
      const uploadUrl = new URL(upload.uploadUrl);
      if (uploadUrl.protocol !== 'https:') throw new Error('Yoto returned a non-HTTPS upload URL.');
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        redirect: 'error',
        headers: { 'Content-Type': 'audio/mpeg' },
        body: new Uint8Array(data),
      });
      if (!response.ok) throw new Error(`Audio upload failed (${response.status})`);
    }
    const result = await sdk.media.getTranscodedUpload(upload.uploadId, true);
    return { filename: basename(candidate), uploadId: upload.uploadId, result };
  }
}
