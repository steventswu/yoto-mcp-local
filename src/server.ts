import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { JobManifestStore } from './job-manifest.js';
import { OperationManager, type OperationTrack } from './operation-manager.js';
import { previewAppend, snapshotCard } from './card-safety.js';
import type { Config } from './config.js';
import { AuthManager } from './auth.js';
import { TokenStore } from './token-store.js';
import { YotoClient, type UploadedTrack } from './yoto.js';

interface AppendOperationTrack extends OperationTrack {
  videoId: string;
  title: string;
  audioPath: string;
}

interface AppendInput {
  cardId: string;
  tracks: Array<{ videoId: string; title: string; audioPath: string }>;
  sourcePlaylistUrl?: string;
  sourcePlaylistId?: string;
  expectedChapterCount?: number;
  expectedFingerprint?: string;
  dryRun?: boolean;
  maxRetries?: number;
}

export function buildServer(config: Config): McpServer {
  const auth = new AuthManager(config, new TokenStore(config.tokenFile));
  const yoto = new YotoClient(config, auth);
  const server = new McpServer({ name: 'yoto-mcp-local', version: '0.1.0' });
  const operations = new OperationManager({ concurrency: 2, maxRetries: 1 });

  server.registerTool('yoto_auth_start', {
    description: 'Start Yoto Authorization Code + PKCE login. Open the returned URL, then call yoto_auth_complete.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (): Promise<CallToolResult> => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await auth.start(), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] }; }
  });

  server.registerTool('yoto_auth_complete', {
    description: 'Finish the pending local PKCE login after the browser callback arrives.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (): Promise<CallToolResult> => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await auth.complete(), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] }; }
  });

  server.registerTool('yoto_auth_status', {
    description: 'Show whether this local server has a Yoto refresh token, without returning the token.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (): Promise<CallToolResult> => ({ content: [{ type: 'text', text: JSON.stringify(await auth.status(), null, 2) }] }));

  server.registerTool('yoto_logout', {
    description: 'Delete the local Yoto token record. This does not call a remote API.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (): Promise<CallToolResult> => {
    try { await auth.logout(); return { content: [{ type: 'text', text: 'Local Yoto tokens deleted.' }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] }; }
  });

  server.registerTool('yoto_list_cards', {
    description: 'Read the authenticated user’s MYO cards. No write operation.',
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => call(() => yoto.sdk().then((sdk) => sdk.content.getMyCards())));

  server.registerTool('yoto_get_card', {
    description: 'Read one MYO card by ID. No write operation.',
    inputSchema: { cardId: z.string().min(1).max(200) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ cardId }) => call(() => yoto.sdk().then((sdk) => sdk.content.getCard(cardId))));

  server.registerTool('yoto_list_devices', {
    description: 'Read linked Yoto player names and status. Does not control or modify devices.',
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => call(() => yoto.sdk().then((sdk) => sdk.devices.getMyDevices())));

  const startAppend = async (args: AppendInput): Promise<unknown> => {
    const current = await yoto.sdk().then((sdk) => sdk.content.getCard(args.cardId));
    const expectedSnapshot = snapshotCard(current, args.cardId);
    if (args.expectedChapterCount !== undefined && args.expectedChapterCount !== expectedSnapshot.chapterCount) {
      throw new Error(`Expected ${args.expectedChapterCount} chapters, found ${expectedSnapshot.chapterCount}.`);
    }
    if (args.expectedFingerprint !== undefined && args.expectedFingerprint !== expectedSnapshot.fingerprint) {
      throw new Error('Card fingerprint does not match expectedFingerprint.');
    }
    if (args.dryRun) return { dryRun: true, preview: previewAppend(current, args.tracks.map((track) => track.title), args.cardId), expectedSnapshot };
    if (args.tracks.length === 0) throw new Error('At least one track is required.');

    const jobId = randomUUID();
    const manifest = new JobManifestStore(join(config.manifestRoot, `${jobId}.json`));
    await manifest.create({
      jobId,
      sourcePlaylistUrl: args.sourcePlaylistUrl,
      sourcePlaylistId: args.sourcePlaylistId,
      targetCardId: args.cardId,
    }, args.tracks.map((track, index) => ({ index, videoId: track.videoId, title: track.title, audioPath: track.audioPath })));
    const resolverPromise = yoto.createIconResolver();
    const uploaded = new Map<string, UploadedTrack>();
    const operationTracks: AppendOperationTrack[] = args.tracks.map((track) => ({ id: track.videoId, ...track }));
    const handle = operations.start({
      tracks: operationTracks,
      concurrency: 2,
      maxRetries: args.maxRetries ?? 1,
      worker: async (track, context) => {
        if (context.attempt > 1) await manifest.retryTrack({ videoId: track.videoId });
        await manifest.updateTrack({ videoId: track.videoId }, { status: 'downloaded', audioPath: track.audioPath });
        context.setPhase('uploading_audio');
        try {
          const uploadedTrack = await yoto.uploadTrack(track.title, track.audioPath, await resolverPromise);
          uploaded.set(track.videoId, uploadedTrack);
          await manifest.updateTrack({ videoId: track.videoId }, {
            status: 'uploaded',
            audioPath: track.audioPath,
            audioSha256: uploadedTrack.audioSha256,
            iconMediaId: uploadedTrack.iconMediaId,
            transcodedAudioHash: uploadedTrack.transcodedAudioHash,
            transcodedInfo: uploadedTrack.transcodedInfo,
            uploadId: uploadedTrack.uploadId,
          });
        } catch (error) {
          await manifest.updateTrack({ videoId: track.videoId }, { status: 'failed', error: errorMessage(error) });
          throw error;
        }
      },
      finalize: async (context) => {
        context.setPhase('card_commit');
        const ordered = operationTracks.map((track) => uploaded.get(track.videoId));
        if (ordered.some((track) => track === undefined)) throw new Error('Operation completed without all uploaded tracks.');
        await yoto.commitAppend({ cardId: args.cardId, uploadedTracks: ordered as UploadedTrack[], expectedSnapshot });
        context.setPhase('readback');
        for (const track of operationTracks) await manifest.updateTrack({ videoId: track.videoId }, { status: 'attached' });
      },
    });
    return { operationId: handle.operationId, jobId, status: handle.initialSnapshot };
  };

  if (config.enableWrites) {
    server.registerTool('yoto_create_card', {
      description: 'Create an empty MYO card. Requires confirm=true; review title and metadata before calling.',
      inputSchema: { title: z.string().min(1).max(200), author: z.string().max(200).optional(), description: z.string().max(2000).optional(), confirm: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (args) => call(async () => {
      const sdk = await yoto.sdk();
      const card = { title: args.title, content: { activity: 'yoto_Player', restricted: true, version: '1', config: { onlineOnly: false }, chapters: [] }, metadata: { ...(args.author ? { author: args.author } : {}), ...(args.description ? { description: args.description } : {}) } } as unknown as Parameters<typeof sdk.content.updateCard>[0];
      return sdk.content.updateCard(card);
    }));

    server.registerTool('yoto_delete_card', {
      description: 'Permanently delete an MYO card. Requires exact confirmation text DELETE <cardId>.',
      inputSchema: { cardId: z.string().min(1).max(200), confirmation: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async ({ cardId, confirmation }) => {
      if (confirmation !== `DELETE ${cardId}`) return { isError: true, content: [{ type: 'text', text: 'Confirmation must exactly match DELETE <cardId>.' }] };
      return call(async () => { await (await yoto.sdk()).content.deleteCard(cardId); return { cardId, deleted: true }; });
    });

    if (config.audioRoot) {
      server.registerTool('yoto_upload_audio', {
        description: 'Upload only an MP3/M4A file inside YOTO_AUDIO_ROOT. Requires confirm=true.',
        inputSchema: { filePath: z.string().min(1), confirm: z.literal(true) },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      }, async ({ filePath }) => call(() => yoto.uploadAudio(filePath)));
    }

    if (config.audioRoot) {
      server.registerTool('yoto_create_playlist_from_files', {
        description: 'Upload validated local audio, resolve an existing Yoto user/public icon by title, then create a new Yoto playlist. Requires confirm=true.',
        inputSchema: {
          title: z.string().min(1).max(140),
          author: z.string().max(200).optional(),
          description: z.string().max(2000).optional(),
          tracks: z.array(z.object({ title: z.string().min(1).max(200), audioPath: z.string().min(1) })).min(1).max(100),
          confirm: z.literal(true),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      }, async (args) => call(() => yoto.createPlaylist(args)));

      server.registerTool('yoto_append_playlist_from_files', {
        description: 'Start a resumable background append operation using existing Yoto user/public icons. Use yoto_get_operation for progress. Requires confirm=true.',
        inputSchema: {
          cardId: z.string().min(1).max(200),
          tracks: z.array(z.object({ videoId: z.string().min(1).max(200), title: z.string().min(1).max(200), audioPath: z.string().min(1) })).min(1).max(100),
          sourcePlaylistUrl: z.string().url().optional(),
          sourcePlaylistId: z.string().max(200).optional(),
          expectedChapterCount: z.number().int().min(0).max(1000).optional(),
          expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
          dryRun: z.boolean().optional(),
          maxRetries: z.number().int().min(0).max(5).optional(),
          confirm: z.literal(true),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      }, async (args) => call(() => startAppend(args)));

      server.registerTool('yoto_get_operation', {
        description: 'Read the status and progress of a background Yoto operation.',
        inputSchema: { operationId: z.string().min(1).max(200) },
        annotations: { readOnlyHint: true, openWorldHint: false },
      }, async ({ operationId }) => call(async () => {
        const status = operations.getStatus(operationId);
        if (!status) throw new Error(`Unknown operation: ${operationId}`);
        return status;
      }));

      server.registerTool('yoto_cancel_operation', {
        description: 'Cancel a running Yoto background operation.',
        inputSchema: { operationId: z.string().min(1).max(200) },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      }, async ({ operationId }) => call(async () => ({ operationId, cancelled: operations.cancel(operationId) })));

      server.registerTool('yoto_get_job_manifest', {
        description: 'Read a local resumable Yoto job manifest by job ID.',
        inputSchema: { jobId: z.string().regex(/^[A-Za-z0-9-]+$/) },
        annotations: { readOnlyHint: true, openWorldHint: false },
      }, async ({ jobId }) => call(() => new JobManifestStore(join(config.manifestRoot, `${jobId}.json`)).read()));
    }

    server.registerTool('yoto_truncate_playlist', {
      description: 'Destructively remove all chapters after keepChapters from an existing Yoto playlist. Requires exact confirmation text TRUNCATE <cardId> TO <keepChapters>.',
      inputSchema: {
        cardId: z.string().min(1).max(200),
        keepChapters: z.number().int().min(1).max(1000),
        expectedChapterCount: z.number().int().min(1).max(1000).optional(),
        expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        confirmation: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async ({ cardId, keepChapters, expectedChapterCount, expectedFingerprint, confirmation }) => {
      if (confirmation !== `TRUNCATE ${cardId} TO ${keepChapters}`) {
        return { isError: true, content: [{ type: 'text', text: `Confirmation must exactly match TRUNCATE ${cardId} TO ${keepChapters}.` }] };
      }
      return call(async () => {
        const current = await yoto.sdk().then((sdk) => sdk.content.getCard(cardId));
        const snapshot = snapshotCard(current, cardId);
        if (expectedChapterCount !== undefined && expectedChapterCount !== snapshot.chapterCount) throw new Error(`Expected ${expectedChapterCount} chapters, found ${snapshot.chapterCount}.`);
        if (expectedFingerprint !== undefined && expectedFingerprint !== snapshot.fingerprint) throw new Error('Card fingerprint does not match expectedFingerprint.');
        return yoto.truncatePlaylist(cardId, keepChapters, snapshot);
      });
    });
  }

  return server;
}

async function call(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try { return { content: [{ type: 'text', text: JSON.stringify(await operation(), null, 2) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] }; }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Operation failed.';
}

export async function main(): Promise<void> {
  const config = (await import('./config.js')).loadConfig();
  const server = buildServer(config);
  await server.connect(new StdioServerTransport());
}
