import type {
  AnchorType,
  Annotation,
  AnnotationKind,
  Chapter,
  ConflictGroup,
  EditorState,
  SearchResult,
  Sentence,
  TextDocument,
  TextToken,
  WorkspaceState
} from './types';

export const STORAGE_KEY = 'sologsb-1022/public-text-annotator/v1';

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createInitialWorkspace(document: TextDocument): WorkspaceState {
  return {
    document: clone(document),
    mode: 'reading',
    selectedChapterId: document.chapters[0]?.id ?? '',
    selectedSentenceId: document.chapters[0]?.sentences[0]?.id ?? '',
    selectedAnnotationId: null,
    query: '',
    dirty: false
  };
}

export function createInitialEditorState(document: TextDocument): EditorState {
  return {
    workspace: createInitialWorkspace(document),
    past: [],
    future: [],
    lastAction: '已载入整理底本'
  };
}

function pushHistory(state: EditorState, next: WorkspaceState, label: string): EditorState {
  return {
    workspace: next,
    past: [...state.past.slice(-39), clone(state.workspace)],
    future: [],
    lastAction: label
  };
}

export type EditorAction =
  | { type: 'hydrate'; workspace: WorkspaceState }
  | { type: 'commit'; label: string; mutate: (document: TextDocument) => void }
  | { type: 'selectChapter'; chapterId: string }
  | { type: 'selectSentence'; chapterId: string; sentenceId: string }
  | { type: 'selectAnnotation'; annotationId: string | null }
  | { type: 'setMode'; mode: WorkspaceState['mode'] }
  | { type: 'setQuery'; query: string }
  | { type: 'undo' }
  | { type: 'redo' };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'hydrate':
      return {
        workspace: action.workspace,
        past: [],
        future: [],
        lastAction: '已恢复离线草稿'
      };
    case 'commit': {
      const next = clone(state.workspace);
      action.mutate(next.document);
      next.document.updatedAt = new Date().toISOString();
      next.dirty = true;
      return pushHistory(state, next, action.label);
    }
    case 'selectChapter': {
      const chapter = state.workspace.document.chapters.find((item) => item.id === action.chapterId);
      return {
        ...state,
        workspace: {
          ...state.workspace,
          selectedChapterId: action.chapterId,
          selectedSentenceId: chapter?.sentences[0]?.id ?? '',
          selectedAnnotationId: null
        }
      };
    }
    case 'selectSentence':
      return {
        ...state,
        workspace: {
          ...state.workspace,
          selectedChapterId: action.chapterId,
          selectedSentenceId: action.sentenceId,
          selectedAnnotationId: null
        }
      };
    case 'selectAnnotation':
      return {
        ...state,
        workspace: { ...state.workspace, selectedAnnotationId: action.annotationId }
      };
    case 'setMode':
      return { ...state, workspace: { ...state.workspace, mode: action.mode } };
    case 'setQuery':
      return { ...state, workspace: { ...state.workspace, query: action.query } };
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        workspace: clone(previous),
        past: state.past.slice(0, -1),
        future: [clone(state.workspace), ...state.future].slice(0, 40),
        lastAction: '已撤销上一步操作'
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        workspace: clone(next),
        past: [...state.past, clone(state.workspace)].slice(-40),
        future: state.future.slice(1),
        lastAction: '已重做上一步操作'
      };
    }
    default:
      return state;
  }
}

export function getSentence(document: TextDocument, sentenceId: string): Sentence | undefined {
  for (const chapter of document.chapters) {
    const sentence = chapter.sentences.find((item) => item.id === sentenceId);
    if (sentence) return sentence;
  }
  return undefined;
}

export function getTargetLabel(document: TextDocument, annotation: Annotation): string {
  const label = getAnchorLabelFromChapters(document.chapters, annotation.anchorId, annotation.anchorType);
  return label ?? (annotation.migrationNote ? annotation.migrationNote : '引用目标已迁移到所属句');
}

/** 在指定章节集合中解析锚点的展示名（版本比较时可传入快照中的章节）。 */
export function getAnchorLabelFromChapters(
  chapters: Chapter[],
  anchorId: string,
  anchorType: AnchorType
): string | undefined {
  if (anchorType === 'chapter') {
    return chapters.find((chapter) => chapter.id === anchorId)?.title;
  }
  for (const chapter of chapters) {
    if (anchorType === 'sentence') {
      const sentence = chapter.sentences.find((item) => item.id === anchorId);
      if (sentence) return `${chapter.title} · 第 ${sentence.order} 句`;
    } else {
      for (const sentence of chapter.sentences) {
        const token = sentence.tokens.find((item) => item.id === anchorId);
        if (token) return `${chapter.title} · “${token.text.trim()}”`;
      }
    }
  }
  return undefined;
}

export interface SentenceStructureResult {
  frontId: string;
  backId: string;
  frontWordNotes: number;
  backWordNotes: number;
  sentenceNotes: number;
}

interface TokenSpan extends TextToken {
  start: number;
  end: number;
}

function tokenSpans(sentence: Sentence): TokenSpan[] {
  const spans: TokenSpan[] = [];
  let offset = 0;
  for (const token of sentence.tokens) {
    // 分词结果与原文严格连续；为稳妥起见，缺失片段用 indexOf 定位。
    const index = sentence.text.indexOf(token.text, offset);
    const start = index >= 0 ? index : offset;
    const end = start + token.text.length;
    spans.push({ ...token, start, end });
    offset = end;
  }
  return spans;
}

function renumberChapter(chapter: Chapter) {
  chapter.sentences.forEach((sentence, index) => {
    sentence.order = index + 1;
  });
}

/**
 * 按光标位置把一句拆成两句：
 * - 前句保留原句 id（即“含原句起点的前句”），句注因此自动留在前句；
 * - 完全落在后半段的词注随原词（token id 不变）跟到后句；
 * - 横跨切分点的词在原词 id 上保留前半段，词注跟前句；后半段是新 token。
 */
export function splitSentenceAt(
  document: TextDocument,
  sentenceId: string,
  offset: number,
  newSentenceId: string,
  newTokenId: (sentenceId: string, hint?: number) => string
): SentenceStructureResult | null {
  for (const chapter of document.chapters) {
    const index = chapter.sentences.findIndex((item) => item.id === sentenceId);
    if (index < 0) continue;
    const original = chapter.sentences[index];
    if (!Number.isInteger(offset) || offset <= 0 || offset >= original.text.length) return null;

    const spans = tokenSpans(original);
    const frontTokens: TextToken[] = [];
    const backTokens: TextToken[] = [];
    const backTokenIds = new Set<string>();
    let hint = 0;

    for (const span of spans) {
      if (span.end <= offset) {
        frontTokens.push({ id: span.id, text: span.text });
      } else if (span.start >= offset) {
        backTokens.push({ id: span.id, text: span.text });
        backTokenIds.add(span.id);
      } else {
        // 横跨光标：前半段沿用原 token id，词注跟前句。
        frontTokens.push({ id: span.id, text: span.text.slice(0, offset - span.start) });
        const tail = span.text.slice(offset - span.start);
        if (tail) {
          const tailToken = { id: newTokenId(newSentenceId, hint++), text: tail };
          backTokens.push(tailToken);
        }
      }
    }

    const frontText = original.text.slice(0, offset);
    const backText = original.text.slice(offset);
    const front: Sentence = { id: original.id, order: original.order, text: frontText, tokens: frontTokens };
    const back: Sentence = { id: newSentenceId, order: original.order + 1, text: backText, tokens: backTokens };
    chapter.sentences.splice(index, 1, front, back);
    renumberChapter(chapter);

    let frontWordNotes = 0;
    let backWordNotes = 0;
    let sentenceNotes = 0;
    for (const annotation of document.annotations) {
      if (annotation.anchorType === 'sentence' && annotation.anchorId === original.id) sentenceNotes += 1;
      if (annotation.anchorType === 'word') {
        if (backTokenIds.has(annotation.anchorId)) backWordNotes += 1;
        else if (frontTokens.some((token) => token.id === annotation.anchorId)) frontWordNotes += 1;
      }
    }
    return { frontId: front.id, backId: back.id, frontWordNotes, backWordNotes, sentenceNotes };
  }
  return null;
}

export interface MergeSentencesResult {
  mergedId: string;
  migratedSentenceNotes: number;
}

/**
 * 把相邻两句合成一句：词注仍指向原词（两个句子的 token 原样保留），
 * 两句的句注全部迁到新句，并在 migrationNote 注明来自哪句。
 */
export function mergeSentences(
  document: TextDocument,
  chapterId: string,
  firstSentenceId: string,
  newSentenceId: string
): MergeSentencesResult | null {
  const chapter = document.chapters.find((item) => item.id === chapterId);
  if (!chapter) return null;
  const index = chapter.sentences.findIndex((item) => item.id === firstSentenceId);
  if (index < 0 || index + 1 >= chapter.sentences.length) return null;

  const first = chapter.sentences[index];
  const second = chapter.sentences[index + 1];
  const merged: Sentence = {
    id: newSentenceId,
    order: first.order,
    text: `${first.text}${second.text}`,
    tokens: [...first.tokens, ...second.tokens]
  };

  const stamp = new Date().toLocaleString('zh-CN');
  let migratedSentenceNotes = 0;
  for (const annotation of document.annotations) {
    if (annotation.anchorType !== 'sentence') continue;
    if (annotation.anchorId === first.id) {
      annotation.anchorId = merged.id;
      annotation.migrationNote = `合句迁入：来自原第 ${first.order} 句「${first.text.slice(0, 12)}」（${stamp}）`;
      migratedSentenceNotes += 1;
    } else if (annotation.anchorId === second.id) {
      annotation.anchorId = merged.id;
      annotation.migrationNote = `合句迁入：来自原第 ${second.order} 句「${second.text.slice(0, 12)}」（${stamp}）`;
      migratedSentenceNotes += 1;
    }
  }

  chapter.sentences.splice(index, 2, merged);
  renumberChapter(chapter);
  return { mergedId: merged.id, migratedSentenceNotes };
}

export function collectSearchResults(document: TextDocument, query: string): SearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];

  const results: SearchResult[] = [];
  for (const chapter of document.chapters) {
    if (chapter.title.toLocaleLowerCase().includes(normalized)) {
      results.push({
        chapterId: chapter.id,
        title: chapter.title,
        excerpt: chapter.summary,
        kind: 'text'
      });
    }
    for (const sentence of chapter.sentences) {
      if (sentence.text.toLocaleLowerCase().includes(normalized)) {
        results.push({
          chapterId: chapter.id,
          sentenceId: sentence.id,
          title: `${chapter.title} · 第 ${sentence.order} 句`,
          excerpt: sentence.text,
          kind: 'text'
        });
      }
    }
  }

  for (const annotation of document.annotations) {
    const searchable = `${annotation.title} ${annotation.body} ${annotation.source}`.toLocaleLowerCase();
    if (searchable.includes(normalized)) {
      const sentence = getSentence(document, annotation.anchorType === 'sentence' ? annotation.anchorId : '');
      results.push({
        chapterId: findChapterIdForAnnotation(document, annotation),
        sentenceId: sentence?.id,
        annotationId: annotation.id,
        title: annotation.title,
        excerpt: `${annotation.source} · ${annotation.body}`,
        kind: 'annotation'
      });
    }
  }

  return results.slice(0, 24);
}

function findChapterIdForAnnotation(document: TextDocument, annotation: Annotation) {
  if (annotation.anchorType === 'chapter') return annotation.anchorId;
  for (const chapter of document.chapters) {
    if (chapter.sentences.some((sentence) => sentence.id === annotation.anchorId)) return chapter.id;
    if (
      annotation.anchorType === 'word' &&
      chapter.sentences.some((sentence) => sentence.tokens.some((token) => token.id === annotation.anchorId))
    ) {
      return chapter.id;
    }
  }
  return document.chapters[0]?.id ?? '';
}

export function getConflictGroups(document: TextDocument): ConflictGroup[] {
  const groups = new Map<string, Annotation[]>();
  for (const annotation of document.annotations) {
    if (annotation.conflictState === 'resolved') continue;
    const key = `${annotation.anchorId}:${annotation.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), annotation]);
  }

  return Array.from(groups.entries())
    .filter(([, items]) => {
      const bodies = new Set(items.map((item) => item.body.trim()));
      return bodies.size > 1;
    })
    .map(([key, items]) => {
      const first = items[0];
      const sentence = first.anchorType === 'sentence' ? getSentence(document, first.anchorId) : undefined;
      const tokenText = findTokenText(document, first.anchorId);
      return {
        key,
        anchorId: first.anchorId,
        anchorType: first.anchorType,
        kind: first.kind,
        anchorLabel: sentence ? `“${sentence.text}”` : tokenText ? `“${tokenText}”` : '文本片段',
        annotations: items
      };
    });
}

function findTokenText(document: TextDocument, tokenId: string) {
  for (const chapter of document.chapters) {
    for (const sentence of chapter.sentences) {
      const token = sentence.tokens.find((item) => item.id === tokenId);
      if (token) return token.text.trim();
    }
  }
  return '';
}

export function kindLabel(kind: AnnotationKind) {
  return {
    footnote: '脚注',
    variant: '异文',
    background: '背景',
    crossref: '互见'
  }[kind];
}

export function updateSentenceText(
  document: TextDocument,
  sentenceId: string,
  text: string,
  tokenize: (value: string, id: string, existing: Sentence['tokens']) => Sentence['tokens']
) {
  let remappedAnnotations = 0;
  for (const chapter of document.chapters) {
    const sentence = chapter.sentences.find((item) => item.id === sentenceId);
    if (!sentence) continue;
    const previousIds = new Set(sentence.tokens.map((token) => token.id));
    sentence.text = text;
    sentence.tokens = tokenize(text, sentence.id, sentence.tokens);
    const remainingIds = new Set(sentence.tokens.map((token) => token.id));

    for (const annotation of document.annotations) {
      if (annotation.anchorType === 'word' && previousIds.has(annotation.anchorId) && !remainingIds.has(annotation.anchorId)) {
        annotation.anchorId = sentence.id;
        annotation.anchorType = 'sentence';
        annotation.title = `${annotation.title}（引用已随修订迁移）`;
        remappedAnnotations += 1;
      }
    }
    break;
  }
  return remappedAnnotations;
}

export function removeAnnotationReferences(document: TextDocument, removedId: string) {
  for (const annotation of document.annotations) {
    annotation.references = annotation.references.filter((id) => id !== removedId);
  }
}

export function toWorkspace(document: TextDocument, fallback: WorkspaceState): WorkspaceState {
  const chapter = document.chapters.find((item) => item.id === fallback.selectedChapterId) ?? document.chapters[0];
  const sentence = chapter?.sentences.find((item) => item.id === fallback.selectedSentenceId) ?? chapter?.sentences[0];
  return {
    document,
    mode: fallback.mode,
    selectedChapterId: chapter?.id ?? '',
    selectedSentenceId: sentence?.id ?? '',
    selectedAnnotationId: fallback.selectedAnnotationId,
    query: fallback.query,
    dirty: false
  };
}
