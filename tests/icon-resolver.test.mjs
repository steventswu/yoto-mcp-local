import assert from 'node:assert/strict';
import test from 'node:test';
import { IconResolver, PUBLIC_ICONS_PATH, USER_ICONS_PATH } from '../dist/icon-resolver.js';

function response(displayIcons, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return { displayIcons }; },
  };
}

function mockFetch({ user = [], publicIcons = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith(USER_ICONS_PATH)) return response(user);
    if (String(url).endsWith(PUBLIC_ICONS_PATH)) return response(publicIcons);
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { calls, fetchImpl };
}

test('user icons win over public icons for the same deterministic keyword match', async () => {
  const { fetchImpl } = mockFetch({
    user: [{ mediaId: 'user-music', title: 'Music Note', publicTags: ['music'] }],
    publicIcons: [{ mediaId: 'public-music', title: 'Music Note', publicTags: ['music'] }],
  });
  const resolver = new IconResolver({ accessToken: 'token', fetchImpl, baseUrl: 'https://example.test' });

  assert.equal(await resolver.resolveMediaId('bedtime music'), 'user-music');
});

test('matches title, tags, and keywords deterministically', async () => {
  const { fetchImpl } = mockFetch({
    publicIcons: [
      { mediaId: 'wrong', title: 'Ocean', publicTags: ['water'] },
      { mediaId: 'right', title: 'Moon', publicTags: ['night'], keywords: ['bedtime', 'lullaby'] },
    ],
  });
  const resolver = new IconResolver({ accessToken: () => 'token', fetchImpl, baseUrl: 'https://example.test' });

  assert.equal(await resolver.resolveMediaId('night lullaby'), 'right');
});

test('uses the fixed music-note/baby fallback when no title match exists', async () => {
  const { fetchImpl } = mockFetch({
    publicIcons: [
      { mediaId: 'baby-fallback', title: 'Baby', publicTags: ['infant'] },
      { mediaId: 'unrelated', title: 'Rocket', publicTags: ['space'] },
    ],
  });
  const resolver = new IconResolver({ accessToken: 'token', fetchImpl, baseUrl: 'https://example.test' });

  assert.equal(await resolver.resolveMediaId('completely unknown track'), 'baby-fallback');
});

test('caches the catalog after the first load', async () => {
  const { calls, fetchImpl } = mockFetch({
    publicIcons: [{ mediaId: 'music', title: 'Music Note', publicTags: ['music'] }],
  });
  const resolver = new IconResolver({ accessToken: 'token', fetchImpl, baseUrl: 'https://example.test' });

  await Promise.all([resolver.resolveMediaId('music'), resolver.resolveMediaId('music')]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname).sort(), [PUBLIC_ICONS_PATH, USER_ICONS_PATH].sort());
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token');
});

test('does not return URLs or upload any image data', async () => {
  const { fetchImpl } = mockFetch({
    publicIcons: [{ mediaId: 'public-id', title: 'Music Note', url: 'https://cdn.example/icon.png' }],
  });
  const resolver = new IconResolver({ accessToken: 'token', fetchImpl, baseUrl: 'https://example.test' });

  assert.deepEqual(await resolver.resolveMediaId('music note'), 'public-id');
});
