import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationManager } from '../dist/operation-manager.js';

const tracks = (count) => Array.from({ length: count }, (_, index) => ({
  id: `track-${index + 1}`,
  title: `Track ${index + 1}`,
}));

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('start returns an operation ID and queued snapshot before background work starts', async () => {
  const manager = new OperationManager({ idFactory: () => 'operation-1' });
  const seen = [];
  const handle = manager.start({
    tracks: tracks(2),
    worker: async (track, context) => {
      context.setPhase('uploading_audio');
      seen.push(track.id);
    },
  });

  assert.equal(handle.operationId, 'operation-1');
  assert.equal(handle.initialSnapshot.status, 'queued');
  assert.equal(handle.initialSnapshot.total, 2);
  assert.equal(manager.getStatus(handle.operationId).status, 'queued');

  const completed = await handle.done;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completed, 2);
  assert.equal(completed.failed, 0);
  assert.deepEqual(seen, ['track-1', 'track-2']);
  assert(completed.progressSnapshots.some((snapshot) => snapshot.status === 'running'));
  assert.equal(completed.progressSnapshots.at(-1).status, 'completed');
  assert.equal(manager.getStatus('missing-operation'), undefined);
});

test('enforces bounded concurrency with the default limit of two', async () => {
  const manager = new OperationManager({ idFactory: () => 'bounded-operation' });
  let active = 0;
  let maximumActive = 0;
  const handle = manager.start({
    tracks: tracks(7),
    worker: async (_track, context) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      context.setPhase('processing');
      await delay(5);
      active -= 1;
    },
  });

  const completed = await handle.done;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completed, 7);
  assert.equal(maximumActive, 2);
});

test('records retries and terminal failures per track', async () => {
  const manager = new OperationManager({ idFactory: () => 'retry-operation' });
  const attempts = new Map();
  const handle = manager.start({
    tracks: tracks(2),
    maxRetries: 1,
    worker: async (track) => {
      const attempt = (attempts.get(track.id) ?? 0) + 1;
      attempts.set(track.id, attempt);
      if (track.id === 'track-1' && attempt === 1) throw new Error('temporary failure');
      if (track.id === 'track-2') throw new Error('permanent failure');
    },
  });

  const result = await handle.done;
  assert.equal(result.status, 'failed');
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.retryCount, 2);
  assert.deepEqual(Object.fromEntries(attempts), { 'track-1': 2, 'track-2': 2 });
  assert.equal(result.tracks[0].status, 'completed');
  assert.equal(result.tracks[1].status, 'failed');
  assert.equal(result.tracks[1].error, 'permanent failure');
  assert(result.progressSnapshots.some((snapshot) => snapshot.phase === 'retrying'));
});

test('cancellation stops queued work, aborts active work, and resolves cancelled', async () => {
  const manager = new OperationManager({ idFactory: () => 'cancel-operation' });
  let started = 0;
  const handle = manager.start({
    tracks: tracks(5),
    worker: async (_track, context) => {
      started += 1;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        context.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        }, { once: true });
      });
    },
  });

  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(handle.getStatus().status, 'running');
  assert.equal(handle.cancel(), true);
  assert.equal(handle.getStatus().status, 'cancelled');

  const result = await handle.done;
  assert.equal(result.status, 'cancelled');
  assert.equal(started, 2);
  assert.equal(result.completed, 0);
  assert.equal(result.tracks.filter((track) => track.status === 'cancelled').length, 5);
  assert.equal(handle.cancel(), false);
});

test('supports custom concurrency and progress observers without letting observer errors fail work', async () => {
  const observed = [];
  const manager = new OperationManager({ idFactory: () => 'observer-operation' });
  const handle = manager.start({
    tracks: tracks(3),
    concurrency: 1,
    onProgress: (snapshot) => {
      observed.push(snapshot.status);
      if (snapshot.phase === 'processing') throw new Error('observer failure');
    },
    worker: async (_track, context) => {
      context.setPhase('processing');
      await delay(1);
    },
  });

  const result = await handle.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.completed, 3);
  assert.deepEqual([...new Set(observed)], ['queued', 'running', 'completed']);
});

test('runs an async finalizer before reporting completed', async () => {
  const manager = new OperationManager({ idFactory: () => 'finalizer-operation' });
  const phases = [];
  const handle = manager.start({
    tracks: tracks(2),
    worker: async (_track, context) => { context.setPhase('uploading'); await delay(1); },
    finalize: async (context) => { context.setPhase('card_commit'); phases.push(context.getStatus().phase); await delay(1); },
  });
  const result = await handle.done;
  assert.equal(result.status, 'completed');
  assert.deepEqual(phases, ['card_commit']);
  assert(result.progressSnapshots.some((snapshot) => snapshot.phase === 'card_commit'));
});

test('rejects invalid limits and duplicate operation IDs', () => {
  assert.throws(() => new OperationManager({ concurrency: 0 }), /concurrency must be a positive integer/);
  assert.throws(() => new OperationManager({ maxRetries: -1 }), /maxRetries must be a non-negative integer/);
  const manager = new OperationManager({ idFactory: () => 'duplicate' });
  const options = { tracks: [], worker: async () => {} };
  manager.start(options);
  assert.throws(() => manager.start(options), /Operation ID already exists: duplicate/);
});
