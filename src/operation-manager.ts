import { randomUUID } from 'node:crypto';

export type OperationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type TrackStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * The minimum track shape required by the manager. The caller can add any
 * source-specific fields (for example videoId or audioPath) to each track.
 */
export interface OperationTrack {
  readonly id: string;
  readonly title?: string;
  readonly [key: string]: unknown;
}

export interface TrackProgress<TTrack extends OperationTrack = OperationTrack> {
  readonly index: number;
  readonly track: TTrack;
  readonly status: TrackStatus;
  readonly phase: string;
  readonly attempt: number;
  readonly error?: string;
}

export interface ProgressSnapshot<TTrack extends OperationTrack = OperationTrack> {
  readonly timestamp: string;
  readonly status: OperationStatus;
  readonly phase: string;
  readonly currentTrack?: TrackProgress<TTrack>;
  readonly activeTracks: readonly TrackProgress<TTrack>[];
  readonly completed: number;
  readonly total: number;
  readonly failed: number;
  /** Number of retry attempts after the first attempt, across all tracks. */
  readonly retryCount: number;
}

export interface OperationSnapshot<TTrack extends OperationTrack = OperationTrack> {
  readonly operationId: string;
  readonly status: OperationStatus;
  readonly phase: string;
  readonly currentTrack?: TrackProgress<TTrack>;
  readonly completed: number;
  readonly total: number;
  readonly failed: number;
  readonly retryCount: number;
  readonly tracks: readonly TrackProgress<TTrack>[];
  readonly progressSnapshots: readonly ProgressSnapshot<TTrack>[];
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface OperationContext<TTrack extends OperationTrack = OperationTrack> {
  readonly operationId: string;
  readonly index: number;
  readonly track: TTrack;
  readonly attempt: number;
  readonly signal: AbortSignal;
  /** Set the phase shown by status queries while this track is active. */
  readonly setPhase: (phase: string) => void;
  /** Return the latest operation snapshot without reaching over the manager. */
  readonly getStatus: () => OperationSnapshot<TTrack>;
}

export type OperationWorker<TTrack extends OperationTrack = OperationTrack> = (
  track: TTrack,
  context: OperationContext<TTrack>,
) => Promise<unknown>;

export interface StartOperationOptions<TTrack extends OperationTrack = OperationTrack> {
  readonly tracks: readonly TTrack[];
  readonly worker: OperationWorker<TTrack>;
  /** Maximum number of track workers running at once. Defaults to 2. */
  readonly concurrency?: number;
  /** Maximum retries per track after its first failed attempt. Defaults to 0. */
  readonly maxRetries?: number;
  /** Called after each status/progress change. Callback errors are ignored. */
  readonly onProgress?: (snapshot: OperationSnapshot<TTrack>) => void;
  /** Optional card/artifact commit after all track workers succeed. */
  readonly finalize?: (context: OperationFinalizeContext<TTrack>) => Promise<void>;
}

export interface OperationFinalizeContext<TTrack extends OperationTrack = OperationTrack> {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly getStatus: () => OperationSnapshot<TTrack>;
  readonly setPhase: (phase: string) => void;
}

export interface OperationHandle<TTrack extends OperationTrack = OperationTrack> {
  readonly operationId: string;
  /** The queued snapshot captured synchronously when start() returned. */
  readonly initialSnapshot: OperationSnapshot<TTrack>;
  /** Resolves when the operation reaches a terminal state. */
  readonly done: Promise<OperationSnapshot<TTrack>>;
  getStatus(): OperationSnapshot<TTrack>;
  cancel(): boolean;
}

export interface OperationManagerOptions {
  readonly concurrency?: number;
  readonly maxRetries?: number;
  /** Injectable for deterministic tests and host-specific ID policies. */
  readonly idFactory?: () => string;
  /** Injectable clock used by snapshots. */
  readonly now?: () => Date;
}

interface TrackState<TTrack extends OperationTrack> {
  readonly index: number;
  readonly track: TTrack;
  status: TrackStatus;
  phase: string;
  attempt: number;
  error?: string;
}

interface OperationRecord<TTrack extends OperationTrack> {
  readonly operationId: string;
  readonly tracks: TrackState<TTrack>[];
  readonly worker: OperationWorker<TTrack>;
  readonly concurrency: number;
  readonly maxRetries: number;
  readonly onProgress?: (snapshot: OperationSnapshot<TTrack>) => void;
  readonly finalize?: (context: OperationFinalizeContext<TTrack>) => Promise<void>;
  readonly createdAt: string;
  readonly abortController: AbortController;
  readonly progressSnapshots: ProgressSnapshot<TTrack>[];
  readonly activeTasks: Set<Promise<void>>;
  readonly waiters: Set<(snapshot: OperationSnapshot<TTrack>) => void>;
  readonly resolveDone: (snapshot: OperationSnapshot<TTrack>) => void;
  status: OperationStatus;
  phase: string;
  completed: number;
  failed: number;
  retryCount: number;
  nextIndex: number;
  currentTrackIndex?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  cancelRequested: boolean;
  settled: boolean;
}

/**
 * In-memory background operation coordinator. It deliberately has no MCP or
 * network dependency so a host can expose start/status/cancel as separate
 * tools without coupling those tools to the work itself.
 */
export class OperationManager {
  private readonly operations = new Map<string, OperationRecord<OperationTrack>>();
  private readonly defaultConcurrency: number;
  private readonly defaultMaxRetries: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: OperationManagerOptions = {}) {
    this.defaultConcurrency = positiveInteger(options.concurrency ?? 2, 'concurrency');
    this.defaultMaxRetries = nonNegativeInteger(options.maxRetries ?? 0, 'maxRetries');
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Creates and queues an operation synchronously. The returned operationId
   * can be sent to an MCP client before any worker starts running.
   */
  start<TTrack extends OperationTrack>(options: StartOperationOptions<TTrack>): OperationHandle<TTrack> {
    if (typeof options.worker !== 'function') throw new TypeError('worker must be a function.');
    const operationId = this.idFactory();
    if (!operationId) throw new Error('idFactory must return a non-empty operation ID.');
    if (this.operations.has(operationId)) throw new Error(`Operation ID already exists: ${operationId}`);

    const concurrency = positiveInteger(options.concurrency ?? this.defaultConcurrency, 'concurrency');
    const maxRetries = nonNegativeInteger(options.maxRetries ?? this.defaultMaxRetries, 'maxRetries');
    const createdAt = this.timestamp();
    let resolveDone!: (snapshot: OperationSnapshot<TTrack>) => void;
    const done = new Promise<OperationSnapshot<TTrack>>((resolve) => { resolveDone = resolve; });
    const record: OperationRecord<TTrack> = {
      operationId,
      tracks: options.tracks.map((track, index) => ({ index, track, status: 'queued', phase: 'queued', attempt: 0 })),
      worker: options.worker,
      concurrency,
      maxRetries,
      onProgress: options.onProgress,
      finalize: options.finalize as unknown as ((context: OperationFinalizeContext<OperationTrack>) => Promise<void>) | undefined,
      createdAt,
      abortController: new AbortController(),
      progressSnapshots: [],
      activeTasks: new Set(),
      waiters: new Set(),
      resolveDone,
      status: 'queued',
      phase: 'queued',
      completed: 0,
      failed: 0,
      retryCount: 0,
      nextIndex: 0,
      cancelRequested: false,
      settled: false,
    };
    this.operations.set(operationId, record as unknown as OperationRecord<OperationTrack>);
    this.emit(record);
    const initialSnapshot = this.snapshot(record);

    // queueMicrotask preserves the synchronous queued state and prevents a
    // caller from missing the operation before the background work starts.
    queueMicrotask(() => {
      void this.run(record).catch((error: unknown) => this.failUnexpected(record, error));
    });

    return {
      operationId,
      initialSnapshot,
      done,
      getStatus: () => this.requireSnapshot<TTrack>(operationId),
      cancel: () => this.cancel(operationId),
    };
  }

  /** Returns a defensive status snapshot, or undefined for an unknown ID. */
  getStatus<TTrack extends OperationTrack = OperationTrack>(operationId: string): OperationSnapshot<TTrack> | undefined {
    const record = this.operations.get(operationId);
    return record ? this.snapshot(record) as unknown as OperationSnapshot<TTrack> : undefined;
  }

  /** Wait for a known operation; unknown IDs resolve to undefined. */
  async wait<TTrack extends OperationTrack = OperationTrack>(operationId: string): Promise<OperationSnapshot<TTrack> | undefined> {
    const record = this.operations.get(operationId);
    if (!record) return undefined;
    if (record.settled) return this.snapshot(record) as unknown as OperationSnapshot<TTrack>;
    return new Promise<OperationSnapshot<TTrack>>((resolve) => {
      record.waiters.add(resolve as unknown as (snapshot: OperationSnapshot<OperationTrack>) => void);
    });
  }

  /**
   * Requests cancellation. Queued work is cancelled immediately; active
   * workers receive AbortSignal and are allowed to settle before done resolves.
   */
  cancel(operationId: string): boolean {
    const record = this.operations.get(operationId);
    if (!record || record.settled || record.cancelRequested) return false;
    record.cancelRequested = true;
    record.abortController.abort();
    for (const state of record.tracks) {
      if (state.status === 'queued') state.status = 'cancelled';
    }
    record.status = 'cancelled';
    record.phase = 'cancelled';
    record.currentTrackIndex = undefined;
    this.emit(record);
    if (record.activeTasks.size === 0) this.finishCancelled(record);
    return true;
  }

  private async run<TTrack extends OperationTrack>(record: OperationRecord<TTrack>): Promise<void> {
    if (record.cancelRequested) {
      this.finishCancelled(record);
      return;
    }
    record.status = 'running';
    record.phase = 'running';
    record.startedAt = this.timestamp();
    this.emit(record);

    while (!record.cancelRequested) {
      while (!record.cancelRequested && record.activeTasks.size < record.concurrency && record.nextIndex < record.tracks.length) {
        const state = record.tracks[record.nextIndex++];
        let task!: Promise<void>;
        task = this.runTrack(record, state).finally(() => record.activeTasks.delete(task));
        record.activeTasks.add(task);
      }
      if (record.activeTasks.size === 0) break;
      await Promise.race(record.activeTasks);
    }

    if (record.activeTasks.size > 0) await Promise.allSettled(record.activeTasks);
    if (record.cancelRequested) {
      this.finishCancelled(record);
    } else if (record.failed > 0) {
      this.finishFailed(record);
    } else {
      try {
        if (record.finalize) {
          record.phase = 'finalizing';
          this.emit(record);
          await record.finalize({
            operationId: record.operationId,
            signal: record.abortController.signal,
            getStatus: () => this.snapshot(record) as unknown as OperationSnapshot<TTrack>,
            setPhase: (phase: string) => {
              if (!phase) throw new Error('phase must be a non-empty string.');
              record.phase = phase;
              this.emit(record);
            },
          });
        }
        if (record.cancelRequested) this.finishCancelled(record);
        else this.finishCompleted(record);
      } catch (error: unknown) {
        record.error = errorMessage(error);
        this.finishFailed(record);
      }
    }
  }

  private async runTrack<TTrack extends OperationTrack>(record: OperationRecord<TTrack>, state: TrackState<TTrack>): Promise<void> {
    while (!record.cancelRequested) {
      state.attempt += 1;
      if (state.attempt > 1) record.retryCount += 1;
      state.status = 'running';
      state.phase = 'running';
      record.currentTrackIndex = state.index;
      record.phase = 'running';
      this.emit(record);
      const context: OperationContext<TTrack> = {
        operationId: record.operationId,
        index: state.index,
        track: state.track,
        get attempt() { return state.attempt; },
        signal: record.abortController.signal,
        setPhase: (phase: string) => {
          if (record.cancelRequested || record.settled) return;
          if (!phase) throw new Error('phase must be a non-empty string.');
          state.phase = phase;
          record.phase = phase;
          record.currentTrackIndex = state.index;
          this.emit(record);
        },
        getStatus: () => this.snapshot(record) as unknown as OperationSnapshot<TTrack>,
      };

      try {
        await record.worker(state.track, context);
        if (record.cancelRequested) {
          state.status = 'cancelled';
          state.phase = 'cancelled';
          this.emit(record);
          return;
        }
        state.status = 'completed';
        state.phase = 'completed';
        record.completed += 1;
        record.phase = 'running';
        this.emit(record);
        return;
      } catch (error: unknown) {
        if (record.cancelRequested) {
          state.status = 'cancelled';
          state.phase = 'cancelled';
          this.emit(record);
          return;
        }
        state.error = errorMessage(error);
        if (state.attempt <= record.maxRetries) {
          state.status = 'queued';
          state.phase = 'retrying';
          record.phase = 'retrying';
          record.error = state.error;
          this.emit(record);
          continue;
        }
        state.status = 'failed';
        state.phase = 'failed';
        record.failed += 1;
        record.phase = 'running';
        record.error = state.error;
        this.emit(record);
        return;
      }
    }

    state.status = 'cancelled';
    state.phase = 'cancelled';
    this.emit(record);
  }

  private finishCompleted<TTrack extends OperationTrack>(record: OperationRecord<TTrack>): void {
    if (record.settled) return;
    record.status = 'completed';
    record.phase = 'completed';
    record.finishedAt = this.timestamp();
    record.currentTrackIndex = undefined;
    this.emit(record);
    this.resolve(record);
  }

  private finishFailed<TTrack extends OperationTrack>(record: OperationRecord<TTrack>): void {
    if (record.settled) return;
    record.status = 'failed';
    record.phase = 'failed';
    record.finishedAt = this.timestamp();
    record.currentTrackIndex = undefined;
    this.emit(record);
    this.resolve(record);
  }

  private finishCancelled<TTrack extends OperationTrack>(record: OperationRecord<TTrack>): void {
    if (record.settled) return;
    record.status = 'cancelled';
    record.phase = 'cancelled';
    record.finishedAt = this.timestamp();
    record.currentTrackIndex = undefined;
    this.emit(record);
    this.resolve(record);
  }

  private failUnexpected<TTrack extends OperationTrack>(record: OperationRecord<TTrack>, error: unknown): void {
    if (record.settled) return;
    record.error = errorMessage(error);
    record.status = 'failed';
    record.phase = 'failed';
    record.finishedAt = this.timestamp();
    record.currentTrackIndex = undefined;
    this.emit(record);
    this.resolve(record);
  }

  private resolve<TTrack extends OperationTrack>(record: OperationRecord<TTrack>): void {
    if (record.settled) return;
    record.settled = true;
    const snapshot = this.snapshot(record);
    record.resolveDone(snapshot);
    for (const waiter of record.waiters) waiter(snapshot);
    record.waiters.clear();
  }

  private emit<TTrack extends OperationTrack>(record: OperationRecord<TTrack>): void {
    const progress: ProgressSnapshot<TTrack> = {
      timestamp: this.timestamp(),
      status: record.status,
      phase: record.phase,
      ...(this.currentTrack(record) ? { currentTrack: this.currentTrack(record) } : {}),
      activeTracks: record.tracks.filter((state) => state.status === 'running').map((state) => this.trackSnapshot(state)),
      completed: record.completed,
      total: record.tracks.length,
      failed: record.failed,
      retryCount: record.retryCount,
    };
    record.progressSnapshots.push(progress);
    const snapshot = this.snapshot(record);
    try { record.onProgress?.(snapshot); } catch { /* observers must not stop the operation */ }
  }

  private snapshot<TTrack extends OperationTrack>(record: OperationRecord<TTrack>): OperationSnapshot<TTrack> {
    const currentTrack = this.currentTrack(record);
    return {
      operationId: record.operationId,
      status: record.status,
      phase: record.phase,
      ...(currentTrack ? { currentTrack } : {}),
      completed: record.completed,
      total: record.tracks.length,
      failed: record.failed,
      retryCount: record.retryCount,
      tracks: record.tracks.map((state) => this.trackSnapshot(state)),
      progressSnapshots: record.progressSnapshots.map((progress) => ({
        ...progress,
        ...(progress.currentTrack ? { currentTrack: this.copyTrackProgress(progress.currentTrack) } : {}),
        activeTracks: progress.activeTracks.map((track) => this.copyTrackProgress(track)),
      })),
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private currentTrack<TTrack extends OperationTrack>(record: OperationRecord<TTrack>): TrackProgress<TTrack> | undefined {
    const preferred = record.currentTrackIndex === undefined ? undefined : record.tracks[record.currentTrackIndex];
    const state = preferred && (preferred.status === 'running' || preferred.status === 'queued')
      ? preferred
      : record.tracks.find((candidate) => candidate.status === 'running' || candidate.status === 'queued');
    return state ? this.trackSnapshot(state) : undefined;
  }

  private trackSnapshot<TTrack extends OperationTrack>(state: TrackState<TTrack>): TrackProgress<TTrack> {
    return {
      index: state.index,
      track: { ...state.track },
      status: state.status,
      phase: state.phase,
      attempt: state.attempt,
      ...(state.error ? { error: state.error } : {}),
    };
  }

  private copyTrackProgress<TTrack extends OperationTrack>(progress: TrackProgress<TTrack>): TrackProgress<TTrack> {
    return { ...progress, track: { ...progress.track } };
  }

  private requireSnapshot<TTrack extends OperationTrack>(operationId: string): OperationSnapshot<TTrack> {
    const snapshot = this.getStatus<TTrack>(operationId);
    if (!snapshot) throw new Error(`Unknown operation: ${operationId}`);
    return snapshot;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
