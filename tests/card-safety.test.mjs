import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CardSafetyError,
  assertChapterReferences,
  assertExpectedSnapshot,
  assertTruncateConfirmation,
  previewAppend,
  snapshotCard,
  validateChapterReferences,
  validateExpectedSnapshot,
  validateTruncateConfirmation,
} from '../dist/card-safety.js';

function chapter(key, title, number = key) {
  const audio = `yoto:#audio-${key}`;
  const icon = `yoto:#icon-${key}`;
  return {
    key,
    title,
    overlayLabel: String(number),
    display: { icon16x16: icon },
    tracks: [{
      key,
      title,
      trackUrl: audio,
      type: 'audio',
      display: { icon16x16: icon },
    }],
  };
}

function card(chapters = [chapter('01', 'One'), chapter('02', 'Two')]) {
  return { cardId: 'card-123', title: 'Fixture Card', content: { chapters } };
}

test('snapshot includes card identity, boundaries, keys, count, and stable fingerprint', () => {
  const snapshot = snapshotCard(card());
  assert.deepEqual(snapshot.cardId, 'card-123');
  assert.deepEqual(snapshot.title, 'Fixture Card');
  assert.equal(snapshot.chapterCount, 2);
  assert.deepEqual(snapshot.firstChapter, { key: '01', title: 'One' });
  assert.deepEqual(snapshot.lastChapter, { key: '02', title: 'Two' });
  assert.deepEqual(snapshot.chapterKeys, ['01', '02']);
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.fingerprint, snapshotCard({ content: { chapters: [chapter('01', 'One'), chapter('02', 'Two')] }, title: 'Fixture Card' }, 'card-123').fingerprint);
});

test('expected snapshot validation detects a changed card', () => {
  const expected = snapshotCard(card());
  const changed = card([chapter('01', 'One'), chapter('02', 'Renamed'), chapter('03', 'Three')]);
  const result = validateExpectedSnapshot(changed, expected);
  assert.equal(result.valid, false);
  assert.deepEqual(result.conflicts, ['chapter count changed', 'last chapter changed', 'chapter keys changed']);
  assert.throws(() => assertExpectedSnapshot(changed, expected), CardSafetyError);
});

test('append preview reports one-based indices without mutating the card', () => {
  const source = card();
  const preview = previewAppend(source, ['Three', 'Four']);
  assert.deepEqual(preview, {
    cardId: 'card-123',
    currentChapterCount: 2,
    additions: [{ index: 3, title: 'Three' }, { index: 4, title: 'Four' }],
    resultingChapterCount: 4,
  });
  assert.equal(source.content.chapters.length, 2);
});

test('truncate confirmation is exact and rejects wrong card, count, or whitespace', () => {
  const expected = 'TRUNCATE card-123 TO 1';
  assert.deepEqual(validateTruncateConfirmation('card-123', 1, expected), { valid: true, expected, actual: expected });
  assert.equal(validateTruncateConfirmation('card-123', 1, 'TRUNCATE card-123 TO 2').valid, false);
  assert.equal(validateTruncateConfirmation('card-123', 1, 'TRUNCATE card-999 TO 1').valid, false);
  assert.throws(() => assertTruncateConfirmation('card-123', 1, `${expected} `), /exactly match/);
});

test('chapter reference validation catches missing audio and icon yoto references', () => {
  const missingAudio = chapter('01', 'One');
  delete missingAudio.tracks[0].trackUrl;
  const missingIcon = chapter('02', 'Two');
  delete missingIcon.display.icon16x16;
  delete missingIcon.tracks[0].display.icon16x16;

  const result = validateChapterReferences([missingAudio, missingIcon]);
  assert.equal(result.valid, false);
  assert.equal(result.chapterCount, 2);
  assert.deepEqual(result.issues.map((issue) => issue.path), [
    'content.chapters[0].tracks[0].trackUrl',
    'content.chapters[1].display.icon16x16',
    'content.chapters[1].tracks[0].display.icon16x16',
  ]);
  assert.throws(() => assertChapterReferences([missingAudio, missingIcon]), /Invalid chapter references/);
});

test('chapter reference validation accepts a complete in-memory card', () => {
  const result = validateChapterReferences(card());
  assert.deepEqual(result, { valid: true, chapterCount: 2, issues: [] });
  assert.doesNotThrow(() => assertChapterReferences(card()));
});
