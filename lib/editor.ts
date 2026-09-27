import type {
  Annotation,
  AnnotationKind,
  Chapter,
  ConflictGroup,
  EditorState,
  SearchResult,
  Sentence,
  TextDocument,
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
      // 拆/合句或恢复快照后，选中句可能已消失，收敛到现存句子
      if (!getSentence(next.document, next.selectedSentenceId)) {
        const chapter =
          next.document.chapters.find((item) => item.id === next.selectedChapterId) ?? next.document.chapters[0];
        next.selectedChapterId = chapter?.id ?? '';
        next.selectedSentenceId = chapter?.sentences[0]?.id ?? '';
      }
      if (
        next.selectedAnnotationId &&
        !next.document.annotations.some((item) => item.id === next.selectedAnnotationId)
      ) {
        next.selectedAnnotationId = null;
      }
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
  if (annotation.anchorType === 'chapter') {
    return document.chapters.find((chapter) => chapter.id === annotation.anchorId)?.title ?? '未知章节';
  }

  for (const chapter of document.chapters) {
    if (annotation.anchorType === 'sentence') {
      const sentence = chapter.sentences.find((item) => item.id === annotation.anchorId);
      if (sentence) return `${chapter.title} · 第 ${sentence.order} 句`;
    } else {
      for (const sentence of chapter.sentences) {
        const token = sentence.tokens.find((item) => item.id === annotation.anchorId);
        if (token) return `${chapter.title} · “${token.text.trim()}”`;
      }
    }
  }

  return '引用目标已迁移到所属句';
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

export interface SplitSentenceResult {
  beforeId: string;
  afterId: string;
  frontWordAnnotations: number;
  backWordAnnotations: number;
  promotedWordAnnotations: number;
}

export interface MergeSentencesResult {
  mergedId: string;
  movedSentenceAnnotations: number;
}

let sentenceSequence = 0;

function nextSentenceId() {
  sentenceSequence += 1;
  return `sentence-merged-${Date.now().toString(36)}-${sentenceSequence.toString(36)}`;
}

function locateSentence(document: TextDocument, sentenceId: string) {
  for (const chapter of document.chapters) {
    const index = chapter.sentences.findIndex((item) => item.id === sentenceId);
    if (index >= 0) return { chapter, index, sentence: chapter.sentences[index] };
  }
  return undefined;
}

function renumberSentences(chapter: Chapter) {
  chapter.sentences.forEach((sentence, index) => {
    sentence.order = index + 1;
  });
}

/**
 * 在光标位置把一句拆成两句：
 * - 落在原文前半段的词注跟到前句，后半段的词注跟到后句；
 *   恰好压在分界字符上的词归后句（该字属于后句开头）。
 * - 句注留在含原句起点的前句（前句保留原句 ID）。
 * - 横跨分界的词无法整体随任一句，其词注提升为前句句注，避免悬空。
 * 新句直接由原 token 序列切出，文本拼接严格还原原文。
 */
export function splitSentence(document: TextDocument, sentenceId: string, caret: number): SplitSentenceResult | null {
  const located = locateSentence(document, sentenceId);
  if (!located) return null;
  const { chapter, index, sentence } = located;
  const cut = Math.max(0, Math.min(caret, sentence.text.length));
  if (cut <= 0 || cut >= sentence.text.length) return null;

  const beforeText = sentence.text.slice(0, cut);
  const afterText = sentence.text.slice(cut);
  const afterId = `${sentence.id}-split-${Date.now().toString(36)}-${(sentenceSequence += 1).toString(36)}`;

  // 原始 token 在原文中的字符区间
  let cursor = 0;
  const ranges = new Map<string, { start: number; end: number }>();
  for (const token of sentence.tokens) {
    ranges.set(token.id, { start: cursor, end: cursor + token.text.length });
    cursor += token.text.length;
  }

  const beforeTokens: Sentence['tokens'] = [];
  const afterTokens: Sentence['tokens'] = [];
  for (const token of sentence.tokens) {
    const range = ranges.get(token.id)!;
    if (range.end <= cut) {
      beforeTokens.push(token);
    } else if (range.start >= cut) {
      afterTokens.push(token);
    } else {
      // 横跨拆分点：按切位断成两段（其词注下方提升为前句句注）
      const head = token.text.slice(0, cut - range.start);
      const tail = token.text.slice(cut - range.start);
      if (head) beforeTokens.push({ id: `${token.id}-split-head`, text: head });
      if (tail) afterTokens.push({ id: `${token.id}-split-tail`, text: tail });
    }
  }

  const before: Sentence = {
    id: sentence.id, // 前句保留原 ID，含原句起点，句注自然留在前句
    order: sentence.order,
    text: beforeText,
    tokens: beforeTokens
  };
  const after: Sentence = {
    id: afterId,
    order: sentence.order + 1,
    text: afterText,
    tokens: afterTokens
  };

  let frontWordAnnotations = 0;
  let backWordAnnotations = 0;
  let promotedWordAnnotations = 0;
  for (const annotation of document.annotations) {
    if (annotation.anchorType !== 'word') continue;
    const range = ranges.get(annotation.anchorId);
    if (!range) continue;
    if (range.end <= cut) {
      // token 保留原 ID 并已进入前句，锚点无需改动
      frontWordAnnotations += 1;
    } else if (range.start >= cut) {
      // token 保留原 ID 并已进入后句，锚点无需改动
      backWordAnnotations += 1;
    } else {
      annotation.anchorId = sentence.id;
      annotation.anchorType = 'sentence';
      annotation.title = `${annotation.title}（拆句时跨分界，已迁入前句）`;
      promotedWordAnnotations += 1;
    }
  }

  chapter.sentences.splice(index, 1, before, after);
  renumberSentences(chapter);
  return { beforeId: sentence.id, afterId, frontWordAnnotations, backWordAnnotations, promotedWordAnnotations };
}

/**
 * 合并同章相邻两句（调用方负责校验相邻关系）。
 * 各词注仍指向原来的词：两个来源句的 token 原样并入并保留原 ID；
 * 来源句的句注迁到新句，并在标题注明来自原第几句。
 */
export function mergeSentences(
  document: TextDocument,
  firstSentenceId: string,
  secondSentenceId: string
): MergeSentencesResult | null {
  const located = locateSentence(document, firstSentenceId);
  if (!located) return null;
  const { chapter, index, sentence: first } = located;
  const second = chapter.sentences[index + 1];
  if (!second || second.id !== secondSentenceId) return null;

  const mergedId = nextSentenceId();
  const firstLabel = `第 ${first.order} 句`;
  const secondLabel = `第 ${second.order} 句`;
  const mergedText = `${first.text}${second.text}`;

  // token 原样并入，拼接严格还原合并句，词注锚点零改动
  const merged: Sentence = {
    id: mergedId,
    order: first.order,
    text: mergedText,
    tokens: [...first.tokens, ...second.tokens]
  };

  let movedSentenceAnnotations = 0;
  for (const annotation of document.annotations) {
    if (annotation.anchorType !== 'sentence') continue;
    if (annotation.anchorId === first.id) {
      annotation.anchorId = mergedId;
      annotation.title = `${annotation.title}（合句，源自原${firstLabel}）`;
      movedSentenceAnnotations += 1;
    } else if (annotation.anchorId === second.id) {
      annotation.anchorId = mergedId;
      annotation.title = `${annotation.title}（合句，源自原${secondLabel}）`;
      movedSentenceAnnotations += 1;
    }
  }

  chapter.sentences.splice(index, 2, merged);
  renumberSentences(chapter);
  return { mergedId, movedSentenceAnnotations };
}

export function removeAnnotationReferences(document: TextDocument, removedId: string) {
  for (const annotation of document.annotations) {
    annotation.references = annotation.references.filter((id) => id !== removedId);
  }
}

/**
 * 修复历史草稿中的悬空词注：anchorType 为 word 但锚点不是任何现存 token 时，
 * 若恰为某句 ID（早期模拟数据的回退写法）则提升为该句句注，避免浏览器重开后关系错乱。
 * 返回被修复的注释数量。
 */
export function repairDangling(document: TextDocument): number {
  const tokenIds = new Set<string>();
  const sentenceIds = new Set<string>();
  for (const chapter of document.chapters) {
    for (const sentence of chapter.sentences) {
      sentenceIds.add(sentence.id);
      for (const token of sentence.tokens) tokenIds.add(token.id);
    }
  }
  let repaired = 0;
  for (const annotation of document.annotations) {
    if (annotation.anchorType !== 'word' || tokenIds.has(annotation.anchorId)) continue;
    if (sentenceIds.has(annotation.anchorId)) {
      annotation.anchorType = 'sentence';
      if (!annotation.title.includes('引用已随修订迁移')) {
        annotation.title = `${annotation.title}（历史词注悬空，已落入所属句）`;
      }
      repaired += 1;
    }
  }
  return repaired;
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
