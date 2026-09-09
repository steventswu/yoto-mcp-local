import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { AuthManager } from './auth.js';
import { TokenStore } from './token-store.js';
import { YotoClient } from './yoto.js';

export function buildServer(config: Config): McpServer {
  const auth = new AuthManager(config, new TokenStore(config.tokenFile));
  const yoto = new YotoClient(config, auth);
  const server = new McpServer({ name: 'yoto-mcp-local', version: '0.1.0' });

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
    description: 'Show whether this local server has a Yoto refresh token, without returning tokens.',
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
