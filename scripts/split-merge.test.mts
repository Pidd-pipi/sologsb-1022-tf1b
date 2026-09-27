// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialDocument } from '../lib/data';
import { splitSentence, mergeSentences, clone } from '../lib/editor';

function findSentence(doc, id) {
  for (const chapter of doc.chapters) {
    const s = chapter.sentences.find((item) => item.id === id);
    if (s) return { chapter, s };
  }
  return null;
}

function annotationsOn(doc, anchorId) {
  return doc.annotations.filter((a) => a.anchorId === anchorId);
}

test('split: word annotations follow halves, sentence note stays in front sentence', () => {
  const doc = clone(initialDocument);
  const target = findSentence(doc, 'sentence-1-1'); // 北冥有鱼，其名为鲲。
  assert.ok(target);
  // find token offsets
  let offset = 0;
  const offsets = new Map();
  for (const t of target.s.tokens) {
    offsets.set(t.id, [offset, offset + t.text.length]);
    offset += t.text.length;
  }
  // cut right before 其 (after 北冥有鱼，)
  const cut = target.s.text.indexOf('其');
  assert.ok(cut > 0);

  // word annotation on 北 (front half) and 鲲 (back half)
  const beiToken = target.s.tokens.find((t) => t.text === '北');
  const beiNote = {
    id: 'ann-bei', anchorId: beiToken.id, anchorType: 'word', kind: 'footnote',
    title: '北', body: '北方', source: 'test', references: [], status: 'open', tags: [],
    conflictState: 'open', updatedAt: 'now'
  };
  doc.annotations.push(beiNote);
  const kunToken = target.s.tokens.find((t) => t.text.includes('鲲'));
  const kunNote = {
    id: 'ann-kun', anchorId: kunToken.id, anchorType: 'word', kind: 'footnote',
    title: '鲲', body: '大鱼', source: 'test', references: [], status: 'open', tags: [],
    conflictState: 'open', updatedAt: 'now'
  };
  doc.annotations.push(kunNote);

  const res = splitSentence(doc, 'sentence-1-1', cut);
  assert.ok(res);
  assert.equal(res.beforeId, 'sentence-1-1');
  const front = findSentence(doc, res.beforeId).s;
  const back = findSentence(doc, res.afterId).s;
  assert.equal(front.text, '北冥有鱼，');
  assert.equal(back.text, '其名为鲲。');

  // sentence notes (annotation-1, annotation-2) remain on front sentence id
  const sentenceNotes = annotationsOn(doc, 'sentence-1-1');
  assert.ok(sentenceNotes.some((a) => a.id === 'annotation-1'));
  assert.ok(sentenceNotes.some((a) => a.id === 'annotation-2'));
  assert.equal(annotationsOn(doc, res.afterId).filter((a) => a.anchorType === 'sentence').length, 0);

  // word note on 北 stays anchored to the token in the front sentence
  const bei = doc.annotations.find((a) => a.id === 'ann-bei');
  assert.ok(front.tokens.some((t) => t.id === bei.anchorId), '北 word note follows front sentence token');
  assert.equal(bei.anchorType, 'word');

  // word note on 鲲 moved to back sentence token
  const kun = doc.annotations.find((a) => a.id === 'ann-kun');
  assert.ok(back.tokens.some((t) => t.id === kun.anchorId), '鲲 word note follows back sentence token');
  assert.equal(kun.anchorType, 'word');

  // orders renumbered
  const chapter = findSentence(doc, res.afterId).chapter;
  chapter.sentences.forEach((s, i) => assert.equal(s.order, i + 1));
});

test('split: word token straddling cut is promoted to front sentence annotation', () => {
  const doc = clone(initialDocument);
  const { s } = findSentence(doc, 'sentence-1-2'); // 鲲之大，不知其几千里也。
  // Fabricate a straddling token: pick cut inside a multi-char non-space token if exists.
  // Segmenter zh word granularity may produce multi-char words; find one.
  let offset = 0;
  let picked = null;
  for (const t of s.tokens) {
    const start = offset; const end = offset + t.text.length;
    if (t.text.trim().length >= 2) { picked = { t, start, end }; break; }
    offset = end;
  }
  assert.ok(picked, 'expected at least one multi-char token');
  doc.annotations.push({
    id: 'ann-straddle', anchorId: picked.t.id, anchorType: 'word', kind: 'variant',
    title: '跨', body: 'x', source: 'test', references: [], status: 'open', tags: [],
    conflictState: 'open', updatedAt: 'now'
  });
  const cut = picked.start + 1;
  const res = splitSentence(doc, s.id, cut);
  assert.ok(res);
  const a = doc.annotations.find((x) => x.id === 'ann-straddle');
  assert.equal(a.anchorType, 'sentence');
  assert.equal(a.anchorId, s.id);
});

test('merge: word notes keep original token ids, sentence notes migrate with provenance', () => {
  const doc = clone(initialDocument);
  // merge chapter 2 sentence 3 (果有言邪？...) and ... need adjacent: merge sentence 2-1 and 2-2
  const first = findSentence(doc, 'sentence-2-1').s;
  const second = findSentence(doc, 'sentence-2-2').s;
  const firstTokenIds = new Set(first.tokens.map((t) => t.id));
  const secondTokenIds = new Set(second.tokens.map((t) => t.id));

  // add a word note on a token in second sentence
  const wordToken = second.tokens.find((t) => t.text.trim());
  doc.annotations.push({
    id: 'ann-word2', anchorId: wordToken.id, anchorType: 'word', kind: 'footnote',
    title: 'w', body: 'b', source: 'test', references: [], status: 'open', tags: [],
    conflictState: 'open', updatedAt: 'now'
  });
  // add sentence note on second
  doc.annotations.push({
    id: 'ann-sent2', anchorId: second.id, anchorType: 'sentence', kind: 'background',
    title: 's', body: 'b', source: 'test', references: [], status: 'open', tags: [],
    conflictState: 'open', updatedAt: 'now'
  });

  const res = mergeSentences(doc, first.id, second.id);
  assert.ok(res);
  const { chapter, s: merged } = findSentence(doc, res.mergedId);
  assert.equal(merged.text, first.text + second.text);

  // original token ids all preserved
  for (const id of firstTokenIds) assert.ok(merged.tokens.some((t) => t.id === id));
  for (const id of secondTokenIds) assert.ok(merged.tokens.some((t) => t.id === id));

  // word note unchanged anchor
  const w = doc.annotations.find((a) => a.id === 'ann-word2');
  assert.equal(w.anchorId, wordToken.id);
  assert.equal(w.anchorType, 'word');

  // sentence notes migrated with provenance
  const existing = doc.annotations.find((a) => a.id === 'ann-sent2');
  assert.equal(existing.anchorId, res.mergedId);
  assert.match(existing.title, /源自原第 2 句/);
  chapter.sentences.forEach((x, i) => assert.equal(x.order, i + 1));
});

test('merge refuses non-adjacent sentences', () => {
  const doc = clone(initialDocument);
  const res = mergeSentences(doc, 'sentence-2-1', 'sentence-2-3');
  assert.equal(res, null);
});

test('split at boundaries returns null', () => {
  const doc = clone(initialDocument);
  const { s } = findSentence(doc, 'sentence-1-1');
  assert.equal(splitSentence(doc, s.id, 0), null);
  assert.equal(splitSentence(doc, s.id, s.text.length), null);
});
