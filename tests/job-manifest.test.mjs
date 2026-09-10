import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  JobManifestStore,
  isTrackResumable,
  trackDeduplicationKey,
} from '../dist/job-manifest.js';

async function withStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'yoto-job-manifest-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new JobManifestStore(join(directory, 'job.json'));
}

const metadata = {
  jobId: 'job-123',
  sourcePlaylistUrl: 'https://www.youtube.com/playlist?list=PL-test',
  sourcePlaylistId: 'PL-test',
  targetCardId: 'card-123',
};

function track(overrides = {}) {
  return {
    index: 0,
    videoId: 'video-0',
    title: 'Track 0',
    ...overrides,
  };
}

test('creates, atomically persists, and resumes a manifest', async (t) => {
  const store = await withStore(t);
  const created = await store.create(metadata, [track()]);

  assert.equal(created.version, 1);
  assert.equal(created.jobId, metadata.jobId);
  assert.equal(created.targetCardId, metadata.targetCardId);
  assert.equal(created.sourcePlaylistId, metadata.sourcePlaylistId);
  assert.equal(created.tracks[0].status, 'pending');
  assert.equal(created.tracks[0].retryCount, 0);
  assert.match(created.tracks[0].timestamps.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const resumed = await store.resume('job-123');
  assert.deepEqual(resumed, created);
  assert.equal((await readdir(join(store.filePath, '..'))).some((name) => name.endsWith('.tmp')), false);
  assert.match(await readFile(store.filePath, 'utf8'), /"tracks"/);
  await assert.rejects(() => store.resume('different-job'), /jobId mismatch/);
});

test('deduplicates exact video, audio hash, and icon identity while allowing distinct identities', async (t) => {
  const store = await withStore(t);
  await store.create(metadata);

  const first = await store.upsertTrack(track({ audioSha256: 'audio-a', iconMediaId: 'icon-a' }));
  const duplicate = await store.upsertTrack(track({ audioSha256: 'audio-a', iconMediaId: 'icon-a', title: 'Renamed duplicate' }));
  const differentIcon = await store.upsertTrack(track({ audioSha256: 'audio-a', iconMediaId: 'icon-b', title: 'Different icon' }));
  const differentAudio = await store.upsertTrack(track({ audioSha256: 'audio-b', iconMediaId: 'icon-a', title: 'Different audio' }));

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.track.title, 'Track 0');
  assert.equal(differentIcon.created, true);
  assert.equal(differentAudio.created, true);
  assert.equal((await store.read()).tracks.length, 3);
  assert.equal(trackDeduplicationKey(first.track), trackDeduplicationKey(duplicate.track));
});

test('updates status and phase timestamps, then retries only the selected failed track', async (t) => {
  const store = await withStore(t);
  await store.create(metadata, [track(), track({ index: 1, videoId: 'video-1', title: 'Track 1' })]);

  const downloaded = await store.updateTrack({ videoId: 'video-0' }, {
    audioPath: '/tmp/audio.m4a',
    audioSha256: 'sha-a',
    status: 'downloaded',
  });
  assert.equal(downloaded.status, 'downloaded');
  assert.equal(downloaded.audioSha256, 'sha-a');
  assert.ok(downloaded.timestamps.downloadedAt);
  assert.equal(isTrackResumable(downloaded), true);

  await store.updateTrack({ index: 1 }, { status: 'failed', error: 'temporary failure' });
  const retried = await store.retryTrack({ videoId: 'video-1' });
  assert.equal(retried.status, 'pending');
  assert.equal(retried.error, undefined);
  assert.equal(retried.retryCount, 1);
  assert.ok(retried.timestamps.updatedAt);

  const manifest = await store.resume();
  assert.equal(manifest.tracks.find((item) => item.videoId === 'video-0').status, 'downloaded');
  assert.equal(manifest.tracks.find((item) => item.videoId === 'video-1').status, 'pending');
});

test('serializes concurrent updates and rejects duplicate manifest creation', async (t) => {
  const store = await withStore(t);
  await store.create(metadata, [track()]);

  await Promise.all([
    store.updateTrack({ index: 0 }, { status: 'downloaded', audioSha256: 'sha-a' }),
    store.updateTrack({ index: 0 }, { status: 'uploaded', transcodedAudioHash: 'transcoded-a' }),
  ]);

  const manifest = await store.read();
  assert.equal(manifest.tracks.length, 1);
  assert.equal(manifest.tracks[0].status, 'uploaded');
  assert.equal(manifest.tracks[0].audioSha256, 'sha-a');
  assert.equal(manifest.tracks[0].transcodedAudioHash, 'transcoded-a');
  await assert.rejects(() => store.create(metadata), /already exists/);
});
