import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { createYotoSdk, type YotoSdk } from '@yotoplay/yoto-sdk';
import { assertChapterReferences, assertExpectedSnapshot, previewAppend, snapshotCard, type CardSnapshot } from './card-safety.js';
import type { Config } from './config.js';
import { AuthManager } from './auth.js';
import { IconResolver } from './icon-resolver.js';

export interface UploadedTrack {
  title: string;
  audioPath: string;
  audioSha256: string;
  uploadId: string;
  transcodedAudioHash: string;
  transcodedInfo: Record<string, unknown>;
  iconMediaId: string;
  trackUrl: string;
  icon16x16: string;
}

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
    let result: Record<string, unknown> | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const candidate = await sdk.media.getTranscodedUpload(upload.uploadId, true) as unknown as Record<string, unknown>;
        if (typeof candidate.transcodedSha256 === 'string' && candidate.transcodedSha256) {
          result = candidate;
          break;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    if (!result) {
      if (lastError instanceof Error) throw lastError;
      throw new Error('Yoto audio transcoding did not return a media hash.');
    }
    return { filename: basename(candidate), uploadId: upload.uploadId, audioSha256: hash, result };
  }

  private async iconResolver(sdk: YotoSdk): Promise<IconResolver> {
    const accessToken = sdk.getAccessToken();
    if (!accessToken) throw new Error('Yoto access token is unavailable.');
    return new IconResolver({ accessToken });
  }

  async createIconResolver(): Promise<IconResolver> {
    return this.iconResolver(await this.sdk());
  }

  async uploadTrack(title: string, audioPath: string, resolver?: IconResolver): Promise<UploadedTrack> {
    const sdk = await this.sdk();
    const iconResolver = resolver ?? await this.iconResolver(sdk);
    const audio = await this.uploadAudio(audioPath) as { uploadId: string; audioSha256: string; result: Record<string, unknown> };
    const transcodedAudioHash = audio.result.transcodedSha256;
    if (typeof transcodedAudioHash !== 'string' || !transcodedAudioHash) {
      throw new Error(`Audio upload for "${title}" returned no transcoded hash.`);
    }
    const iconMediaId = await iconResolver.resolveMediaId(title);
    const info = (audio.result.transcodedInfo ?? {}) as Record<string, unknown>;
    return {
      title,
      audioPath,
      audioSha256: audio.audioSha256,
      uploadId: audio.uploadId,
      transcodedAudioHash,
      transcodedInfo: info,
      iconMediaId,
      trackUrl: `yoto:#${transcodedAudioHash}`,
      icon16x16: `yoto:#${iconMediaId}`,
    };
  }

  private buildChapters(tracks: readonly UploadedTrack[], offset = 0): Array<Record<string, unknown>> {
    return tracks.map((track, index) => {
      const info = track.transcodedInfo;
      const number = offset + index + 1;
      const key = String(number).padStart(2, '0');
      const duration = typeof info.duration === 'number' ? info.duration : undefined;
      const fileSize = typeof info.fileSize === 'number' ? info.fileSize : undefined;
      const format = typeof info.format === 'string' ? info.format : 'opus';
      const channels = info.channels === 'mono' ? 'mono' : 'stereo';
      return {
        key,
        title: track.title,
        overlayLabel: String(number),
        ...(duration === undefined ? {} : { duration }),
        ...(fileSize === undefined ? {} : { fileSize }),
        display: { icon16x16: track.icon16x16 },
        tracks: [{
          key,
          title: track.title,
          overlayLabel: String(number),
          trackUrl: track.trackUrl,
          ...(duration === undefined ? {} : { duration }),
          ...(fileSize === undefined ? {} : { fileSize }),
          channels,
          format,
          type: 'audio',
          uid: '',
          display: { icon16x16: track.icon16x16 },
        }],
      };
    });
  }

  async createPlaylist(args: {
    title: string;
    author?: string;
    description?: string;
    tracks: Array<{ title: string; audioPath: string }>;
  }): Promise<unknown> {
    const sdk = await this.sdk();
    const resolver = await this.iconResolver(sdk);
    const uploaded: UploadedTrack[] = [];
    for (const track of args.tracks) {
      uploaded.push(await this.uploadTrack(track.title, track.audioPath, resolver));
    }

    const chapters = this.buildChapters(uploaded);
    assertChapterReferences({ content: { chapters } });
    const totalDuration = chapters.reduce((sum, chapter) => sum + (typeof chapter.duration === 'number' ? chapter.duration : 0), 0);
    const totalFileSize = chapters.reduce((sum, chapter) => sum + (typeof chapter.fileSize === 'number' ? chapter.fileSize : 0), 0);
    const metadata: Record<string, unknown> = {
      ...(args.author ? { author: args.author } : {}),
      ...(args.description ? { description: args.description } : {}),
      media: { duration: totalDuration, fileSize: totalFileSize },
    };
    return sdk.content.updateCard({
      title: args.title,
      content: { activity: 'yoto_Player', chapters, config: { resumeTimeout: 2592000, onlineOnly: false }, playbackType: 'linear' },
      metadata,
    } as unknown as Parameters<typeof sdk.content.updateCard>[0]);
  }

  async appendPlaylist(args: {
    cardId: string;
    tracks: Array<{ title: string; audioPath: string }>;
    expectedSnapshot?: CardSnapshot;
    dryRun?: boolean;
  }): Promise<unknown> {
    const sdk = await this.sdk();
    const current = await sdk.content.getCard(args.cardId) as unknown as {
      cardId?: string;
      title?: string;
      content: Record<string, unknown>;
      metadata: Record<string, unknown>;
    };
    const snapshot = snapshotCard(current, args.cardId);
    if (args.expectedSnapshot) assertExpectedSnapshot(current, args.expectedSnapshot, args.cardId);
    if (args.dryRun) return { dryRun: true, preview: previewAppend(current, args.tracks.map((track) => track.title), args.cardId), expectedSnapshot: snapshot };
    const resolver = await this.iconResolver(sdk);
    const uploaded: UploadedTrack[] = [];
    for (const track of args.tracks) {
      uploaded.push(await this.uploadTrack(track.title, track.audioPath, resolver));
    }
    return this.commitAppend({ cardId: args.cardId, uploadedTracks: uploaded, expectedSnapshot: args.expectedSnapshot ?? snapshot });
  }

  async commitAppend(args: {
    cardId: string;
    uploadedTracks: readonly UploadedTrack[];
    expectedSnapshot?: CardSnapshot;
    dryRun?: boolean;
  }): Promise<unknown> {
    const sdk = await this.sdk();
    const current = await sdk.content.getCard(args.cardId) as unknown as {
      cardId?: string;
      title?: string;
      content: Record<string, unknown>;
      metadata: Record<string, unknown>;
    };
    const snapshot = snapshotCard(current, args.cardId);
    if (args.expectedSnapshot) assertExpectedSnapshot(current, args.expectedSnapshot, args.cardId);
    const existingChapters = Array.isArray(current.content?.chapters) ? current.content.chapters as Array<Record<string, unknown>> : [];
    const chapters = this.buildChapters(args.uploadedTracks, existingChapters.length);
    const mergedChapters = [...existingChapters, ...chapters];
    if (args.dryRun) return { dryRun: true, preview: previewAppend(current, args.uploadedTracks.map((track) => track.title), args.cardId), expectedSnapshot: snapshot };
    assertChapterReferences({ content: { chapters: mergedChapters } });
    const priorMedia = (current.metadata?.media ?? {}) as Record<string, unknown>;
    const addedDuration = chapters.reduce((sum, chapter) => sum + (typeof chapter.duration === 'number' ? chapter.duration : 0), 0);
    const addedFileSize = chapters.reduce((sum, chapter) => sum + (typeof chapter.fileSize === 'number' ? chapter.fileSize : 0), 0);
    const updated = await sdk.content.updateCard({
      ...current,
      cardId: args.cardId,
      title: current.title,
      content: { ...current.content, chapters: mergedChapters },
      metadata: {
        ...current.metadata,
        media: {
          ...priorMedia,
          duration: (typeof priorMedia.duration === 'number' ? priorMedia.duration : 0) + addedDuration,
          fileSize: (typeof priorMedia.fileSize === 'number' ? priorMedia.fileSize : 0) + addedFileSize,
        },
      },
    } as unknown as Parameters<typeof sdk.content.updateCard>[0]);
    const readback = await sdk.content.getCard(args.cardId);
    assertChapterReferences(readback);
    return { cardId: args.cardId, card: updated, readback, expectedSnapshot: snapshot, added: chapters.length };
  }

  async truncatePlaylist(cardId: string, keepChapters: number, expectedSnapshot?: CardSnapshot): Promise<unknown> {
    const sdk = await this.sdk();
    const current = await sdk.content.getCard(cardId) as unknown as {
      cardId?: string;
      title?: string;
      content: Record<string, unknown>;
      metadata: Record<string, unknown>;
    };
    const snapshot = snapshotCard(current, cardId);
    if (expectedSnapshot) assertExpectedSnapshot(current, expectedSnapshot, cardId);
    const chapters = Array.isArray(current.content?.chapters) ? current.content.chapters as Array<Record<string, unknown>> : [];
    if (keepChapters < 1 || keepChapters >= chapters.length) {
      throw new Error(`keepChapters must be between 1 and ${Math.max(1, chapters.length - 1)} for this card.`);
    }
    const removedChapters = chapters.slice(keepChapters).map((chapter) => chapter.title).filter((title): title is string => typeof title === 'string');
    const keptChapters = chapters.slice(0, keepChapters);
    assertChapterReferences({ content: { chapters: keptChapters } });
    const priorMedia = (current.metadata?.media ?? {}) as Record<string, unknown>;
    const duration = keptChapters.reduce((sum, chapter) => sum + (typeof chapter.duration === 'number' ? chapter.duration : 0), 0);
    const fileSize = keptChapters.reduce((sum, chapter) => sum + (typeof chapter.fileSize === 'number' ? chapter.fileSize : 0), 0);
    const updated = await sdk.content.updateCard({
      ...current,
      cardId,
      title: current.title,
      content: { ...current.content, chapters: keptChapters },
      metadata: { ...current.metadata, media: { ...priorMedia, duration, fileSize } },
    } as unknown as Parameters<typeof sdk.content.updateCard>[0]);
    const readback = await sdk.content.getCard(cardId);
    assertChapterReferences(readback);
    return { cardId, keptChapters: keptChapters.length, removedChapters, card: updated, readback, expectedSnapshot: snapshot };
  }
}
