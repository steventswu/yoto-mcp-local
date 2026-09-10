import { createHash } from 'node:crypto';

/** A deliberately small view of a Yoto chapter used by the safety helpers. */
export interface ChapterLike {
  key?: unknown;
  title?: unknown;
  display?: unknown;
  tracks?: unknown;
  [key: string]: unknown;
}

export interface CardLike {
  cardId?: unknown;
  id?: unknown;
  title?: unknown;
  content?: unknown;
}

export interface ChapterBoundary {
  key: string | null;
  title: string | null;
}

export interface CardSnapshot {
  cardId: string;
  title: string;
  chapterCount: number;
  firstChapter: ChapterBoundary | null;
  lastChapter: ChapterBoundary | null;
  chapterKeys: string[];
  fingerprint: string;
}

export interface SnapshotValidationResult {
  valid: boolean;
  conflicts: string[];
  expected: CardSnapshot;
  actual: CardSnapshot;
}

export interface AppendPreviewEntry {
  /** One-based position the chapter will occupy after the append. */
  index: number;
  title: string;
}

export interface AppendPreview {
  cardId: string;
  currentChapterCount: number;
  additions: AppendPreviewEntry[];
  resultingChapterCount: number;
}

export interface ConfirmationValidationResult {
  valid: boolean;
  expected: string;
  actual: string;
}

export interface ChapterReferenceIssue {
  chapterIndex: number;
  path: string;
  reference: 'audio' | 'icon';
  message: string;
}

export interface ChapterReferenceValidationResult {
  valid: boolean;
  chapterCount: number;
  issues: ChapterReferenceIssue[];
}

export class CardSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardSafetyError';
  }
}

/**
 * Take the stable, mutation-sensitive subset of a card used for optimistic
 * concurrency checks. The original card is never modified.
 */
export function snapshotCard(card: CardLike, cardId?: string): CardSnapshot {
  const resolvedCardId = cardId ?? stringValue(card.cardId) ?? stringValue(card.id) ?? '';
  const title = stringValue(card.title) ?? '';
  const chapters = getChapters(card);
  const chapterKeys = chapters.map((chapter) => stringValue(chapter.key) ?? '');
  const firstChapter = chapters.length > 0 ? chapterBoundary(chapters[0]) : null;
  const lastChapter = chapters.length > 0 ? chapterBoundary(chapters[chapters.length - 1]) : null;
  const identity = {
    cardId: resolvedCardId,
    title,
    chapterCount: chapters.length,
    firstChapter,
    lastChapter,
    chapterKeys,
  };

  return {
    ...identity,
    fingerprint: createHash('sha256').update(canonicalJson(identity)).digest('hex'),
  };
}

/**
 * Compare a freshly read card with a snapshot captured before a write.
 * Comparison includes the fingerprint and its constituent fields so callers
 * can explain exactly why a write was rejected.
 */
export function validateExpectedSnapshot(actualCard: CardLike, expected: CardSnapshot, cardId?: string): SnapshotValidationResult {
  const actual = snapshotCard(actualCard, cardId ?? expected.cardId);
  const conflicts: string[] = [];

  if (actual.cardId !== expected.cardId) conflicts.push('cardId changed');
  if (actual.title !== expected.title) conflicts.push('title changed');
  if (actual.chapterCount !== expected.chapterCount) conflicts.push('chapter count changed');
  if (!sameBoundary(actual.firstChapter, expected.firstChapter)) conflicts.push('first chapter changed');
  if (!sameBoundary(actual.lastChapter, expected.lastChapter)) conflicts.push('last chapter changed');
  if (!sameStringArray(actual.chapterKeys, expected.chapterKeys)) conflicts.push('chapter keys changed');
  if (actual.fingerprint !== expected.fingerprint && conflicts.length === 0) conflicts.push('card fingerprint changed');

  return { valid: conflicts.length === 0, conflicts, expected, actual };
}

/** Throw a CardSafetyError when the expected snapshot no longer matches. */
export function assertExpectedSnapshot(actualCard: CardLike, expected: CardSnapshot, cardId?: string): CardSnapshot {
  const result = validateExpectedSnapshot(actualCard, expected, cardId);
  if (!result.valid) {
    throw new CardSafetyError(`Card changed before update: ${result.conflicts.join(', ')}.`);
  }
  return result.actual;
}

/**
 * Build a non-mutating append preview. Indices are one-based chapter
 * positions, matching Yoto overlay labels and the existing chapter builder.
 */
export function previewAppend(card: CardLike, titles: readonly string[], cardId?: string): AppendPreview {
  const snapshot = snapshotCard(card, cardId);
  const additions = titles.map((title, offset) => ({
    index: snapshot.chapterCount + offset + 1,
    title,
  }));
  return {
    cardId: snapshot.cardId,
    currentChapterCount: snapshot.chapterCount,
    additions,
    resultingChapterCount: snapshot.chapterCount + additions.length,
  };
}

/** Return the exact confirmation string required before truncating a card. */
export function expectedTruncateConfirmation(cardId: string, keepChapters: number): string {
  return `TRUNCATE ${cardId} TO ${keepChapters}`;
}

export function validateTruncateConfirmation(
  cardId: string,
  keepChapters: number,
  confirmation: string,
): ConfirmationValidationResult {
  const expected = expectedTruncateConfirmation(cardId, keepChapters);
  return { valid: confirmation === expected, expected, actual: confirmation };
}

/** Throw when a truncate confirmation is missing or differs by any character. */
export function assertTruncateConfirmation(cardId: string, keepChapters: number, confirmation: string): void {
  const result = validateTruncateConfirmation(cardId, keepChapters, confirmation);
  if (!result.valid) {
    throw new CardSafetyError(`Confirmation must exactly match ${result.expected}.`);
  }
}

/**
 * Verify that each chapter exposes the references required by a playable Yoto
 * chapter: an audio trackUrl and a display icon16x16, both in yoto:# form.
 * The check accepts the same icon at chapter and nested-track level only when
 * both locations are present; this catches partially-built chapters before a
 * card update.
 */
export function validateChapterReferences(cardOrChapters: CardLike | readonly ChapterLike[]): ChapterReferenceValidationResult {
  const chapters: ChapterLike[] = Array.isArray(cardOrChapters)
    ? [...cardOrChapters].filter(isRecord)
    : getChapters(cardOrChapters as CardLike);
  const issues: ChapterReferenceIssue[] = [];

  chapters.forEach((chapter, chapterIndex) => {
    const chapterPath = `content.chapters[${chapterIndex}]`;
    const chapterIcon = displayIcon(chapter);
    if (!isYotoReference(chapterIcon)) {
      issues.push({ chapterIndex, path: `${chapterPath}.display.icon16x16`, reference: 'icon', message: 'missing yoto:# icon16x16 reference' });
    }

    const tracks: Array<Record<string, unknown>> = Array.isArray(chapter.tracks)
      ? chapter.tracks.filter(isRecord)
      : [];
    if (tracks.length === 0) {
      issues.push({ chapterIndex, path: `${chapterPath}.tracks`, reference: 'audio', message: 'missing audio track' });
      issues.push({ chapterIndex, path: `${chapterPath}.tracks`, reference: 'icon', message: 'missing nested track icon' });
      return;
    }

    tracks.forEach((track, trackIndex) => {
      const trackPath = `${chapterPath}.tracks[${trackIndex}]`;
      if (!isYotoReference(track.trackUrl)) {
        issues.push({ chapterIndex, path: `${trackPath}.trackUrl`, reference: 'audio', message: 'missing yoto:# audio trackUrl reference' });
      }
      if (!isYotoReference(displayIcon(track))) {
        issues.push({ chapterIndex, path: `${trackPath}.display.icon16x16`, reference: 'icon', message: 'missing yoto:# icon16x16 reference' });
      }
    });
  });

  return { valid: issues.length === 0, chapterCount: chapters.length, issues };
}

/** Throw when any chapter is missing a required audio or icon reference. */
export function assertChapterReferences(cardOrChapters: CardLike | readonly ChapterLike[]): void {
  const result = validateChapterReferences(cardOrChapters);
  if (!result.valid) {
    throw new CardSafetyError(`Invalid chapter references: ${result.issues.map((issue) => issue.path).join(', ')}.`);
  }
}

function getChapters(card: CardLike): ChapterLike[] {
  if (!isRecord(card.content) || !Array.isArray(card.content.chapters)) return [];
  return card.content.chapters.filter(isRecord);
}

function chapterBoundary(chapter: ChapterLike): ChapterBoundary {
  return { key: stringValue(chapter.key), title: stringValue(chapter.title) };
}

function displayIcon(value: ChapterLike): unknown {
  return isRecord(value.display) ? value.display.icon16x16 : undefined;
}

function isYotoReference(value: unknown): value is string {
  return typeof value === 'string' && /^yoto:#\S+$/.test(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameBoundary(left: ChapterBoundary | null, right: ChapterBoundary | null): boolean {
  return left?.key === right?.key && left?.title === right?.title;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
