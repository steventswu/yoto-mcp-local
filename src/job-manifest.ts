import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';

export type TrackStatus = 'pending' | 'downloaded' | 'uploaded' | 'attached' | 'failed';

export interface JobMetadata {
  jobId: string;
  sourcePlaylistUrl?: string;
  sourcePlaylistId?: string;
  targetCardId: string;
}

export interface TrackTimestamps {
  createdAt: string;
  updatedAt: string;
  downloadedAt?: string;
  uploadedAt?: string;
  attachedAt?: string;
  failedAt?: string;
}

export interface TrackRecord {
  index: number;
  videoId: string;
  title: string;
  audioPath?: string;
  audioSha256?: string;
  iconMediaId?: string;
  transcodedAudioHash?: string;
  transcodedInfo?: Record<string, unknown>;
  uploadId?: string;
  status: TrackStatus;
  error?: string;
  retryCount: number;
  timestamps: TrackTimestamps;
}

export interface JobManifest extends JobMetadata {
  version: 1;
  createdAt: string;
  updatedAt: string;
  tracks: TrackRecord[];
}

export interface NewTrackRecord {
  index: number;
  videoId: string;
  title: string;
  audioPath?: string;
  audioSha256?: string;
  iconMediaId?: string;
  transcodedAudioHash?: string;
  transcodedInfo?: Record<string, unknown>;
  uploadId?: string;
  status?: TrackStatus;
  error?: string;
  retryCount?: number;
}

export type TrackSelector = { index: number } | { videoId: string };

export interface TrackPatch {
  title?: string;
  audioPath?: string;
  audioSha256?: string;
  iconMediaId?: string;
  transcodedAudioHash?: string;
  transcodedInfo?: Record<string, unknown>;
  uploadId?: string;
  status?: TrackStatus;
  error?: string;
}

export interface UpsertTrackResult {
  created: boolean;
  track: TrackRecord;
  manifest: JobManifest;
}

const TRACK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'downloaded',
  'uploaded',
  'attached',
  'failed',
]);

/**
 * Returns the stable identity used to detect an already-recorded track.
 * Missing values are represented explicitly so a pending record can be
 * resumed without being confused with a record whose identity is complete.
 */
export function trackDeduplicationKey(track: Pick<TrackRecord, 'videoId' | 'audioSha256' | 'iconMediaId'>): string {
  return JSON.stringify([
    track.videoId,
    track.audioSha256 ?? null,
    track.iconMediaId ?? null,
  ]);
}

export function isTrackResumable(track: TrackRecord): boolean {
  return track.status !== 'attached';
}

export class JobManifestStore {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(public readonly filePath: string) {}

  /** Create and persist a new manifest. Existing manifests are never overwritten. */
  public async create(metadata: JobMetadata, tracks: readonly NewTrackRecord[] = []): Promise<JobManifest> {
    return this.enqueue(async () => {
      const manifest = createManifest(metadata, tracks);
      await this.assertAbsent();
      await writeJsonAtomically(this.filePath, manifest);
      return clone(manifest);
    });
  }

  /** Read an existing manifest for a resumable job. */
  public async resume(jobId?: string): Promise<JobManifest> {
    const manifest = await this.read();
    if (jobId !== undefined && manifest.jobId !== jobId) {
      throw new Error(`Manifest jobId mismatch: expected ${jobId}, found ${manifest.jobId}.`);
    }
    return manifest;
  }

  public async read(): Promise<JobManifest> {
    const raw = await readFile(this.filePath, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Invalid job manifest JSON at ${this.filePath}: ${errorMessage(error)}`);
    }
    return clone(validateManifest(value));
  }

  /** Add a track unless the complete video/audio/icon identity is already present. */
  public async upsertTrack(trackInput: NewTrackRecord): Promise<UpsertTrackResult> {
    return this.enqueue(async () => {
      const manifest = await this.read();
      const candidate = createTrack(trackInput);
      const existing = manifest.tracks.find(
        (track) => trackDeduplicationKey(track) === trackDeduplicationKey(candidate),
      );
      if (existing) {
        return { created: false, track: clone(existing), manifest: clone(manifest) };
      }

      manifest.tracks.push(candidate);
      sortTracks(manifest);
      touchManifest(manifest);
      await writeJsonAtomically(this.filePath, manifest);
      return { created: true, track: clone(candidate), manifest: clone(manifest) };
    });
  }

  /** Update one track and automatically update phase timestamps. */
  public async updateTrack(selector: TrackSelector, patch: TrackPatch): Promise<TrackRecord> {
    return this.enqueue(async () => {
      const manifest = await this.read();
      const track = findTrack(manifest, selector);
      const previousStatus = track.status;
      applyTrackPatch(track, patch);
      applyStatusTimestamp(track, previousStatus);
      touchManifest(manifest);
      await writeJsonAtomically(this.filePath, manifest);
      return clone(track);
    });
  }

  /** Move a failed track back to pending so a caller can retry only that track. */
  public async retryTrack(selector: TrackSelector): Promise<TrackRecord> {
    return this.enqueue(async () => {
      const manifest = await this.read();
      const track = findTrack(manifest, selector);
      track.status = 'pending';
      track.error = undefined;
      track.retryCount += 1;
      delete track.timestamps.failedAt;
      track.timestamps.updatedAt = now();
      touchManifest(manifest);
      await writeJsonAtomically(this.filePath, manifest);
      return clone(track);
    });
  }

  private async assertAbsent(): Promise<void> {
    try {
      await readFile(this.filePath);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
    throw new Error(`Job manifest already exists: ${this.filePath}`);
  }

  /** Serialize mutations so concurrent callers cannot overwrite each other's read-modify-write. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function createManifest(metadata: JobMetadata, tracks: readonly NewTrackRecord[]): JobManifest {
  validateMetadata(metadata);
  const timestamp = now();
  const manifest: JobManifest = {
    version: 1,
    jobId: metadata.jobId,
    ...(metadata.sourcePlaylistUrl === undefined ? {} : { sourcePlaylistUrl: metadata.sourcePlaylistUrl }),
    ...(metadata.sourcePlaylistId === undefined ? {} : { sourcePlaylistId: metadata.sourcePlaylistId }),
    targetCardId: metadata.targetCardId,
    createdAt: timestamp,
    updatedAt: timestamp,
    tracks: tracks.map(createTrack),
  };
  sortTracks(manifest);
  return manifest;
}

function createTrack(input: NewTrackRecord): TrackRecord {
  if (!Number.isInteger(input.index) || input.index < 0) throw new Error('Track index must be a non-negative integer.');
  requireText(input.videoId, 'Track videoId');
  requireText(input.title, 'Track title');
  const status = input.status ?? 'pending';
  if (!TRACK_STATUSES.has(status)) throw new Error(`Invalid track status: ${status}`);
  const timestamp = now();
  return {
    index: input.index,
    videoId: input.videoId,
    title: input.title,
    ...(input.audioPath === undefined ? {} : { audioPath: input.audioPath }),
    ...(input.audioSha256 === undefined ? {} : { audioSha256: input.audioSha256 }),
    ...(input.iconMediaId === undefined ? {} : { iconMediaId: input.iconMediaId }),
    ...(input.transcodedAudioHash === undefined ? {} : { transcodedAudioHash: input.transcodedAudioHash }),
    ...(input.transcodedInfo === undefined ? {} : { transcodedInfo: input.transcodedInfo }),
    ...(input.uploadId === undefined ? {} : { uploadId: input.uploadId }),
    status,
    ...(input.error === undefined ? {} : { error: input.error }),
    retryCount: input.retryCount ?? 0,
    timestamps: {
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(status === 'downloaded' || status === 'uploaded' || status === 'attached' ? { downloadedAt: timestamp } : {}),
      ...(status === 'uploaded' || status === 'attached' ? { uploadedAt: timestamp } : {}),
      ...(status === 'attached' ? { attachedAt: timestamp } : {}),
      ...(status === 'failed' ? { failedAt: timestamp } : {}),
    },
  };
}

function validateManifest(value: unknown): JobManifest {
  if (!isRecord(value)) throw new Error('Job manifest must be a JSON object.');
  if (value.version !== 1) throw new Error('Unsupported job manifest version.');
  validateMetadata(value as unknown as JobMetadata);
  requireTimestamp(value.createdAt, 'Manifest createdAt');
  requireTimestamp(value.updatedAt, 'Manifest updatedAt');
  if (!Array.isArray(value.tracks)) throw new Error('Manifest tracks must be an array.');

  const tracks = value.tracks.map((rawTrack) => validateTrack(rawTrack));
  const keys = new Set<string>();
  for (const track of tracks) {
    const key = trackDeduplicationKey(track);
    if (keys.has(key)) throw new Error(`Duplicate track identity in manifest: ${key}`);
    keys.add(key);
  }
  return value as unknown as JobManifest;
}

function validateTrack(value: unknown): TrackRecord {
  if (!isRecord(value)) throw new Error('Manifest track must be a JSON object.');
  if (!Number.isInteger(value.index) || (value.index as number) < 0) throw new Error('Track index must be a non-negative integer.');
  requireText(value.videoId, 'Track videoId');
  requireText(value.title, 'Track title');
  if (typeof value.status !== 'string' || !TRACK_STATUSES.has(value.status)) throw new Error(`Invalid track status: ${String(value.status)}`);
  if (!Number.isInteger(value.retryCount) || (value.retryCount as number) < 0) throw new Error('Track retryCount must be a non-negative integer.');
  if (!isRecord(value.timestamps)) throw new Error('Track timestamps must be an object.');
  requireTimestamp(value.timestamps.createdAt, 'Track createdAt');
  requireTimestamp(value.timestamps.updatedAt, 'Track updatedAt');
  for (const key of ['downloadedAt', 'uploadedAt', 'attachedAt', 'failedAt']) {
    if (value.timestamps[key] !== undefined) requireTimestamp(value.timestamps[key], `Track ${key}`);
  }
  return value as unknown as TrackRecord;
}

function validateMetadata(metadata: JobMetadata): void {
  requireText(metadata.jobId, 'jobId');
  requireText(metadata.targetCardId, 'targetCardId');
  if (metadata.sourcePlaylistUrl === undefined && metadata.sourcePlaylistId === undefined) {
    throw new Error('At least one source playlist URL or ID is required.');
  }
  if (metadata.sourcePlaylistUrl !== undefined) requireText(metadata.sourcePlaylistUrl, 'sourcePlaylistUrl');
  if (metadata.sourcePlaylistId !== undefined) requireText(metadata.sourcePlaylistId, 'sourcePlaylistId');
}

function applyTrackPatch(track: TrackRecord, patch: TrackPatch): void {
  if (patch.title !== undefined) track.title = patch.title;
  if (patch.audioPath !== undefined) track.audioPath = patch.audioPath;
  if (patch.audioSha256 !== undefined) track.audioSha256 = patch.audioSha256;
  if (patch.iconMediaId !== undefined) track.iconMediaId = patch.iconMediaId;
  if (patch.transcodedAudioHash !== undefined) track.transcodedAudioHash = patch.transcodedAudioHash;
  if (patch.transcodedInfo !== undefined) track.transcodedInfo = patch.transcodedInfo;
  if (patch.uploadId !== undefined) track.uploadId = patch.uploadId;
  if (patch.error !== undefined) track.error = patch.error;
  if (patch.status !== undefined) {
    if (!TRACK_STATUSES.has(patch.status)) throw new Error(`Invalid track status: ${patch.status}`);
    track.status = patch.status;
  }
}

function applyStatusTimestamp(track: TrackRecord, previousStatus: TrackStatus): void {
  const timestamp = now();
  track.timestamps.updatedAt = timestamp;
  if (track.status !== previousStatus || track.status === 'downloaded' || track.status === 'uploaded' || track.status === 'attached' || track.status === 'failed') {
    if (track.status === 'downloaded') track.timestamps.downloadedAt = timestamp;
    if (track.status === 'uploaded') {
      track.timestamps.downloadedAt ??= timestamp;
      track.timestamps.uploadedAt = timestamp;
    }
    if (track.status === 'attached') {
      track.timestamps.downloadedAt ??= timestamp;
      track.timestamps.uploadedAt ??= timestamp;
      track.timestamps.attachedAt = timestamp;
    }
    if (track.status === 'failed') track.timestamps.failedAt = timestamp;
  }
}

function findTrack(manifest: JobManifest, selector: TrackSelector): TrackRecord {
  const matches = manifest.tracks.filter((track) => 'index' in selector ? track.index === selector.index : track.videoId === selector.videoId);
  if (matches.length === 0) throw new Error('Track not found in job manifest.');
  if (matches.length > 1) throw new Error('Track selector is ambiguous in job manifest.');
  return matches[0];
}

function sortTracks(manifest: JobManifest): void {
  manifest.tracks.sort((left, right) => left.index - right.index);
}

function touchManifest(manifest: JobManifest): void {
  manifest.updatedAt = now();
}

async function writeJsonAtomically(filePath: string, value: JobManifest): Promise<void> {
  const targetPath = resolve(filePath);
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = resolve(directory, `.${basename(targetPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function now(): string {
  return new Date().toISOString();
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required.`);
}

function requireTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
