/**
 * orpg.3.0 serialization helpers: canonical JSON hashing, snapshot
 * assembly (IndexedDB records -> OrpgExport), and application
 * (OrpgExport -> IndexedDB upsert).
 */
import type {
  DbRecord,
  OrpgCharacter,
  OrpgExport,
  OrpgItem,
  OrpgManifest,
  OrpgMessage,
  OrpgRoom,
} from './types';

/** Deterministic JSON: sorted object keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const ser = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return null; // cycle guard
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(ser);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = ser((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(ser(value));
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashExport(data: OrpgExport): Promise<string> {
  return sha256Hex(canonicalJson(data));
}

/** Drop `modelInfo` snapshots (catalog metadata, ~90% of payload size). */
export function stripModelInfo(data: OrpgExport): OrpgExport {
  const characters: Record<string, OrpgCharacter> = {};
  for (const [id, ch] of Object.entries(data.characters)) {
    characters[id] = { ...ch, modelInfo: null };
  }
  return { ...data, characters };
}

/**
 * Assemble an OrpgExport from the flat records of one room.
 * `records` are raw wrapped records read from IndexedDB.
 */
export function assembleExport(
  room: DbRecord<OrpgRoom>,
  manifest: DbRecord<OrpgManifest> | undefined,
  all: Map<string, DbRecord<unknown>>,
): OrpgExport {
  const man = manifest?.value;
  const characters: Record<string, OrpgCharacter> = {};
  const messages: Record<string, OrpgMessage> = {};
  const items: Record<string, OrpgItem> = {};

  for (const id of man?.characterIds ?? []) {
    const rec = all.get(`v3:character:${id}`) as DbRecord<OrpgCharacter> | undefined;
    if (rec?.value) characters[id] = rec.value;
  }
  for (const id of man?.messageIds ?? []) {
    const rec = all.get(`v3:message:${id}`) as DbRecord<OrpgMessage> | undefined;
    if (rec?.value) messages[id] = rec.value;
  }
  for (const id of man?.itemIds ?? []) {
    const rec = all.get(`v3:item:${id}`) as DbRecord<OrpgItem> | undefined;
    if (rec?.value) items[id] = rec.value;
  }

  return {
    version: 'orpg.3.0',
    title: room.value.title,
    characters,
    messages,
    items,
    artifacts: {},
    artifactFiles: {},
    artifactVersions: {},
    artifactFileContents: {},
  };
}

/** Records that must be (re)written to reproduce `data` as room `roomId`. */
export interface ExportUpsertPlan {
  room: DbRecord<OrpgRoom>;
  manifest: DbRecord<OrpgManifest>;
  characters: DbRecord<OrpgCharacter>[];
  messages: DbRecord<OrpgMessage>[];
  items: DbRecord<OrpgItem>[];
}

/**
 * Build the upsert plan for applying a remote OrpgExport locally.
 * The room record is synthesized with `now` timestamps only when the room
 * does not exist yet; otherwise the local room row is left untouched so
 * the sidebar keeps its own ordering metadata.
 */
export function planUpsert(
  data: OrpgExport,
  roomId: string,
  now: string,
  existingRoom: DbRecord<OrpgRoom> | undefined,
): ExportUpsertPlan {
  const roomValue: OrpgRoom = existingRoom
    ? {
        ...existingRoom.value,
        title: data.title || existingRoom.value.title,
        updatedAt: now,
      }
    : {
        id: roomId,
        title: data.title || 'Imported chat',
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        version: 3,
        isPinned: false,
      };

  const characterIds = Object.keys(data.characters);
  const messageIds = Object.keys(data.messages);
  const itemIds = Object.keys(data.items);

  const firstCreatedAt = messageIds
    .map((id) => data.messages[id]?.createdAt)
    .filter((t): t is string => !!t)
    .sort()[0];
  if (!existingRoom && firstCreatedAt) {
    roomValue.createdAt = firstCreatedAt;
  }

  return {
    room: { value: roomValue, key: `v3:room:${roomId}` },
    manifest: {
      value: { characterIds, messageIds, artifactIds: [], itemIds },
      key: `v3:manifest:${roomId}`,
    },
    characters: characterIds.map((id) => ({
      value: data.characters[id],
      key: `v3:character:${id}`,
    })),
    messages: messageIds.map((id) => ({
      value: data.messages[id],
      key: `v3:message:${id}`,
    })),
    items: itemIds.map((id) => ({ value: data.items[id], key: `v3:item:${id}` })),
  };
}
