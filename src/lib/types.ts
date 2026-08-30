/**
 * OpenRouter playground (orpg.3.0) data model, captured from live
 * IndexedDB `openrouter:playground:v3` recon (2026-08-30).
 *
 * Every record in that store is stored wrapped as `{ value, key }`
 * where `key` is `v3:<kind>:<id>` on disk, and `value.id` repeats the id.
 */

export const PLAYGROUND_DB = 'openrouter:playground:v3';
export const PLAYGROUND_STORE = 'openrouter:playground:v3';

/** Content block inside an item's `data`. */
export type OrpgContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string; annotations: unknown[]; logprobs?: unknown[] }
  | { type: 'reasoning_text'; text: string }
  | { type: 'refusal'; refusal: string }
  | { type: 'input_image'; image_url: string }
  | (Record<string, unknown> & { type: string });

export interface OrpgItemData {
  id?: string;
  type: 'message' | 'reasoning' | 'image_generation_call' | (string & {});
  role?: 'user' | 'assistant';
  status?: string;
  content?: OrpgContentPart[];
  result?: string;
  [k: string]: unknown;
}

export interface OrpgItem {
  id: string;
  messageId: string;
  data: OrpgItemData;
}

export interface OrpgMessageItemRef {
  id: string;
  outputIndex?: number;
  type: string;
  sequenceIndex?: number;
}

export interface OrpgMessage {
  id: string;
  characterId: string;
  contentType: string;
  context: string;
  parentMessageId?: string;
  createdAt: string;
  updatedAt: string;
  isRetrying: boolean;
  isEdited: boolean;
  isCollapsed: boolean;
  type: 'user' | 'assistant' | (string & {});
  isGenerating?: boolean;
  metadata?: Record<string, unknown>;
  items: OrpgMessageItemRef[];
}

export interface OrpgCharacter {
  id: string;
  model: string;
  /** Full model catalog snapshot; large. Optional in sync payload (strippable). */
  modelInfo: Record<string, unknown> | null;
  description?: string;
  includeDefaultSystemPrompt?: boolean;
  isStreaming?: boolean;
  samplingParameters?: Record<string, unknown>;
  isDisabled?: boolean;
  isRemoved?: boolean;
  createdAt?: string;
  updatedAt?: string;
  plugins?: unknown[];
  [k: string]: unknown;
}

export interface OrpgRoom {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  version: number;
  isPinned: boolean;
}

export interface OrpgManifest {
  characterIds: string[];
  messageIds: string[];
  artifactIds: string[];
  itemIds: string[];
}

/** Single-room export file, byte-compatible with OpenRouter's official Export. */
export interface OrpgExport {
  version: 'orpg.3.0';
  title: string;
  characters: Record<string, OrpgCharacter>;
  messages: Record<string, OrpgMessage>;
  items: Record<string, OrpgItem>;
  artifacts: Record<string, unknown>;
  artifactFiles: Record<string, unknown>;
  artifactVersions: Record<string, unknown>;
  artifactFileContents: Record<string, unknown>;
}

/** Wrapped record as physically stored in IndexedDB. */
export interface DbRecord<T> {
  value: T;
  key: string;
}

/* ------------------------------------------------------------------ */
/* Sync-layer types                                                    */
/* ------------------------------------------------------------------ */

/** Per-room entry in the remote sync manifest. */
export interface SyncManifestRoom {
  title: string;
  updatedAt: string;
  hash: string;
}

/** Remote manifest stored at `<root>/manifest.json`. */
export interface SyncManifest {
  format: 'orpg-sync';
  version: 1;
  updatedAt: string;
  rooms: Record<string, SyncManifestRoom>;
  /** roomId -> deletedAt. Propagates deletions across devices safely. */
  deleted: Record<string, string>;
}

export const emptySyncManifest = (): SyncManifest => ({
  format: 'orpg-sync',
  version: 1,
  updatedAt: new Date(0).toISOString(),
  rooms: {},
  deleted: {},
});

/** Local tombstone for a room deleted on this device. */
export interface Tombstone {
  roomId: string;
  deletedAt: string;
}

/** Result of one sync run, for UI display. */
export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  pushed: string[];
  pulled: string[];
  deletedRemote: string[];
  skipped: number;
  conflicts: { roomId: string; resolution: 'local' | 'remote' }[];
  errors: string[];
}

export const emptySyncReport = (): SyncReport => ({
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  pushed: [],
  pulled: [],
  deletedRemote: [],
  skipped: 0,
  conflicts: [],
  errors: [],
});

export interface LocalRoomSnapshot {
  room: OrpgRoom;
  data: OrpgExport;
}
