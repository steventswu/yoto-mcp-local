import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuthManager } from '../dist/auth.js';
import { loadConfig } from '../dist/config.js';
import { buildServer } from '../dist/server.js';
import { TokenStore } from '../dist/token-store.js';
import { YotoClient } from '../dist/yoto.js';

function config(overrides = {}) {
  return {
    clientId: 'test-public-client',
    authDomain: 'login.yotoplay.com',
    audience: 'https://api.yotoplay.com',
    redirectPort: 8787,
    tokenFile: join(tmpdir(), 'unused-yoto-test-token.json'),
    enableWrites: false,
    maxUploadBytes: 1024,
    ...overrides,
  };
}

async function listTools(serverConfig) {
  const server = buildServer(serverConfig);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return { client, server, result: await client.listTools() };
  } catch (error) {
    await Promise.all([client.close(), server.close()]);
    throw error;
  }
}

test('configuration fails closed without a client ID', () => {
  assert.throws(() => loadConfig({}), /YOTO_CLIENT_ID is required/);
});

test('configuration defaults to read-only and bounded uploads', () => {
  const result = loadConfig({ YOTO_CLIENT_ID: 'public-client', YOTO_MAX_UPLOAD_BYTES: '-1' });
  assert.equal(result.enableWrites, false);
  assert.equal(result.audioRoot, undefined);
  assert.equal(result.maxUploadBytes, 100 * 1024 * 1024);
});

test('an expired authentication attempt does not terminate the MCP process', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yoto-auth-timeout-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const serverConfig = config({ redirectPort: 0, tokenFile: join(directory, 'tokens.json') });
  const auth = new AuthManager(serverConfig, new TokenStore(serverConfig.tokenFile), 10);

  await auth.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(() => auth.complete(), /No authentication flow is pending/);
});

test('token store writes mode 0600 and removes the token on logout', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yoto-token-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'private', 'tokens.json');
  const store = new TokenStore(tokenFile);

  await store.save({ accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: 1 });
  const directoryMode = (await lstat(join(directory, 'private'))).mode & 0o777;
  const mode = (await lstat(tokenFile)).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(mode, 0o600);
  assert.equal(JSON.parse(await readFile(tokenFile, 'utf8')).refreshToken, 'test-refresh');

  await store.clear();
  await assert.rejects(() => lstat(tokenFile), { code: 'ENOENT' });
});

test('default tool list contains no Yoto write operations', async () => {
  const { client, server, result } = await listTools(config());
  try {
    const names = result.tools.map((tool) => tool.name);
    assert(names.includes('yoto_list_cards'));
    assert(names.includes('yoto_get_card'));
    assert(names.includes('yoto_list_devices'));
    assert(!names.includes('yoto_create_card'));
    assert(!names.includes('yoto_delete_card'));
    assert(!names.includes('yoto_upload_audio'));
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test('write tools are explicit and uploads require an audio root', async () => {
  const withoutRoot = await listTools(config({ enableWrites: true }));
  try {
    const names = withoutRoot.result.tools.map((tool) => tool.name);
    assert(names.includes('yoto_create_card'));
    assert(names.includes('yoto_delete_card'));
    assert(!names.includes('yoto_upload_audio'));
  } finally {
    await Promise.all([withoutRoot.client.close(), withoutRoot.server.close()]);
  }

  const withRoot = await listTools(config({ enableWrites: true, audioRoot: tmpdir() }));
  try {
    assert(withRoot.result.tools.some((tool) => tool.name === 'yoto_upload_audio'));
  } finally {
    await Promise.all([withRoot.client.close(), withRoot.server.close()]);
  }
});

test('delete rejects anything except the exact confirmation phrase', async () => {
  const connected = await listTools(config({ enableWrites: true }));
  try {
    const result = await connected.client.callTool({
      name: 'yoto_delete_card',
      arguments: { cardId: 'card-123', confirmation: 'yes' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exactly match DELETE/);
  } finally {
    await Promise.all([connected.client.close(), connected.server.close()]);
  }
});

test('audio upload rejects paths outside the configured root before authentication', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yoto-path-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'allowed');
  const outside = join(directory, 'outside.mp3');
  await mkdir(root);
  await writeFile(outside, 'not-real-audio');

  const serverConfig = config({ enableWrites: true, audioRoot: root });
  const auth = new AuthManager(serverConfig, new TokenStore(join(directory, 'tokens.json')));
  const client = new YotoClient(serverConfig, auth);
  await assert.rejects(() => client.uploadAudio(outside), /inside YOTO_AUDIO_ROOT/);
});

test('audio upload rejects symlink escapes and unsupported files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yoto-symlink-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'allowed');
  const outside = join(directory, 'outside.mp3');
  const link = join(root, 'linked.mp3');
  const textFile = join(root, 'notes.txt');
  await mkdir(root);
  await writeFile(outside, 'not-real-audio');
  await symlink(outside, link);
  await writeFile(textFile, 'not-real-audio');

  const serverConfig = config({ enableWrites: true, audioRoot: root });
  const auth = new AuthManager(serverConfig, new TokenStore(join(directory, 'tokens.json')));
  const client = new YotoClient(serverConfig, auth);
  await assert.rejects(() => client.uploadAudio(link), /inside YOTO_AUDIO_ROOT/);
  await assert.rejects(() => client.uploadAudio(textFile), /Only .mp3 and .m4a/);
});

test('audio upload rejects files over the configured limit before authentication', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yoto-size-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'allowed');
  const audioFile = join(root, 'oversized.mp3');
  await mkdir(root);
  await writeFile(audioFile, Buffer.alloc(2048));

  const serverConfig = config({ enableWrites: true, audioRoot: root, maxUploadBytes: 1024 });
  const auth = new AuthManager(serverConfig, new TokenStore(join(directory, 'tokens.json')));
  const client = new YotoClient(serverConfig, auth);
  await assert.rejects(() => client.uploadAudio(audioFile), /exceeds the configured size limit/);
});
