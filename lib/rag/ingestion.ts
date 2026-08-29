import { createHash } from "node:crypto";

export type IngestionAccess =
  | { scope: "workspace" }
  | { scope: "restricted"; principals: readonly { type: "user" | "role" | "group"; id: string }[] };

export type DocumentIngestionInput = {
  workspaceId: string;
  sourceId?: string;
  externalId: string;
  title: string;
  sourceUri?: string;
  mimeType?: string;
  language?: string;
  content: string;
  metadata?: Record<string, unknown>;
  access?: IngestionAccess;
};

export type PreparedChunk = {
  ordinal: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  headingPath: readonly string[];
  charStart: number;
  charEnd: number;
  citationLabel: string;
};

export type DocumentIngestionPlan = Omit<DocumentIngestionInput, "content" | "access"> & {
  normalizedContent: string;
  contentHash: string;
  access: IngestionAccess;
  chunks: readonly PreparedChunk[];
};

export type ChunkingOptions = {
  maxCharacters?: number;
  overlapCharacters?: number;
  minimumCharacters?: number;
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function normalizeKnowledgeText(value: string) {
  return value
    .normalize("NFC")
    .replace(/\u0000/gu, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map(line => line.replace(/[\t ]+$/gu, ""))
    .join("\n")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
}

type TextBlock = { content: string; start: number; end: number; headingPath: readonly string[] };

function blocksFromMarkdown(content: string) {
  const lines = content.split("\n");
  const headings: string[] = [];
  const blocks: TextBlock[] = [];
  let offset = 0;
  let paragraphStart = -1;
  let paragraphLines: string[] = [];
  let paragraphHeadings: readonly string[] = [];

  const flush = () => {
    if (!paragraphLines.length || paragraphStart < 0) return;
    const value = paragraphLines.join("\n").trim();
    if (value) {
      const start = content.indexOf(value, paragraphStart);
      blocks.push({ content: value, start, end: start + value.length, headingPath: paragraphHeadings });
    }
    paragraphStart = -1;
    paragraphLines = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      flush();
      const depth = heading[1].length;
      headings.splice(depth - 1);
      headings[depth - 1] = heading[2].trim();
    } else if (!line.trim()) {
      flush();
    } else {
      if (paragraphStart < 0) {
        paragraphStart = offset;
        paragraphHeadings = [...headings];
      }
      paragraphLines.push(line);
    }
    offset += line.length + 1;
  }
  flush();
  return blocks;
}

function splitLargeBlock(block: TextBlock, maximum: number, overlap: number) {
  if (block.content.length <= maximum) return [block];
  const parts: TextBlock[] = [];
  let cursor = 0;
  while (cursor < block.content.length) {
    let end = Math.min(block.content.length, cursor + maximum);
    if (end < block.content.length) {
      const whitespace = block.content.lastIndexOf(" ", end);
      if (whitespace > cursor + Math.floor(maximum * 0.6)) end = whitespace;
    }
    const raw = block.content.slice(cursor, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const content = raw.trim();
    const start = block.start + cursor + leading;
    parts.push({ content, start, end: block.start + end - trailing, headingPath: block.headingPath });
    if (end >= block.content.length) break;
    const next = Math.max(cursor + 1, end - overlap);
    cursor = next;
  }
  return parts;
}

export function chunkKnowledgeText(input: string, options: ChunkingOptions = {}) {
  const content = normalizeKnowledgeText(input);
  if (!content) return [];
  const maximum = Math.min(5_000, Math.max(256, options.maxCharacters ?? 1_400));
  const minimum = Math.min(maximum, Math.max(40, options.minimumCharacters ?? 120));
  const overlap = Math.min(Math.floor(maximum / 3), Math.max(0, options.overlapCharacters ?? 160));
  const blocks = blocksFromMarkdown(content).flatMap(block => splitLargeBlock(block, maximum, overlap));
  const merged: TextBlock[] = [];

  for (const block of blocks) {
    const previous = merged.at(-1);
    const sameHeading = previous && previous.headingPath.join("\u0000") === block.headingPath.join("\u0000");
    if (previous && sameHeading && previous.content.length < minimum && previous.content.length + block.content.length + 2 <= maximum) {
      previous.content = `${previous.content}\n\n${block.content}`;
      previous.end = block.end;
    } else if (previous && sameHeading && previous.content.length + block.content.length + 2 <= maximum) {
      previous.content = `${previous.content}\n\n${block.content}`;
      previous.end = block.end;
    } else {
      merged.push({ ...block });
    }
  }

  return merged.map((block, ordinal): PreparedChunk => ({
    ordinal,
    content: block.content,
    contentHash: digest(block.content),
    tokenCount: Math.max(1, Math.ceil(block.content.length / 4)),
    headingPath: block.headingPath,
    charStart: block.start,
    charEnd: block.end,
    citationLabel: block.headingPath.length ? block.headingPath.join(" › ") : `Passage ${ordinal + 1}`,
  }));
}

export function prepareDocumentIngestion(input: DocumentIngestionInput, options: ChunkingOptions = {}): DocumentIngestionPlan {
  if (!input.workspaceId.trim()) throw new Error("workspaceId is required");
  if (!input.externalId.trim() || input.externalId.length > 1_000) throw new Error("externalId is invalid");
  if (!input.title.trim() || input.title.length > 500) throw new Error("title is invalid");
  if (input.content.length > 5_000_000) throw new Error("document exceeds the 5,000,000 character ingestion limit");
  if (input.metadata && (Array.isArray(input.metadata) || typeof input.metadata !== "object")) throw new Error("metadata must be an object");

  const normalizedContent = normalizeKnowledgeText(input.content);
  if (!normalizedContent) throw new Error("document content is empty");
  const access = input.access || { scope: "workspace" as const };
  if (access.scope === "restricted" && !access.principals.length) throw new Error("restricted documents require at least one principal");
  const chunks = chunkKnowledgeText(normalizedContent, options);
  if (!chunks.length) throw new Error("document produced no searchable chunks");

  return {
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    externalId: input.externalId.trim(),
    title: input.title.trim(),
    sourceUri: input.sourceUri,
    mimeType: input.mimeType,
    language: input.language,
    metadata: input.metadata || {},
    normalizedContent,
    contentHash: digest(normalizedContent),
    access,
    chunks,
  };
}
