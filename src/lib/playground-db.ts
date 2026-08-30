/**
 * IndexedDB bridge for `openrouter:playground:v3`.
 * Runs inside the openrouter.ai content script (same-origin isolated
 * world shares the page's IndexedDB).
 */
import { assembleExport } from './orpg';
import type {
  DbRecord,
  LocalRoomSnapshot,
  OrpgManifest,
  OrpgRoom,
} from './types';
import { PLAYGROUND_DB as DB, PLAYGROUND_STORE as STORE } from './types';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('failed to open ' + DB));
  });
}

export async function readAllRecords(): Promise<Map<string, DbRecord<unknown>>> {
  const db = await openDb();
  try {
    return await new Promise<Map<string, DbRecord<unknown>>>((resolve, reject) => {
      const out = new Map<string, DbRecord<unknown>>();
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          // Records are physically stored as {value, key} wrappers — store
          // cursor.value as-is, do NOT wrap again.
          out.set(String(cursor.key), cursor.value as DbRecord<unknown>);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error ?? new Error('read failed'));
      tx.onabort = () => reject(tx.error ?? new Error('read aborted'));
    });
  } finally {
    db.close();
  }
}

/** Full local snapshot: one OrpgExport per room (hashing is the engine's job). */
export async function readLocalSnapshot(): Promise<{
  rooms: LocalRoomSnapshot[];
  roomIds: string[];
}> {
  const all = await readAllRecords();
  const master = all.get('v3:master:rooms') as
    | DbRecord<{ roomIds: string[] }>
    | undefined;
  const roomIds = master?.value.roomIds ?? [];

  const rooms: LocalRoomSnapshot[] = [];
  for (const roomId of roomIds) {
    const room = all.get(`v3:room:${roomId}`) as DbRecord<OrpgRoom> | undefined;
    if (!room?.value) continue;
    const manifest = all.get(`v3:manifest:${roomId}`) as
      | DbRecord<OrpgManifest>
      | undefined;
    rooms.push({ room: room.value, data: assembleExport(room, manifest, all) });
  }
  return { rooms, roomIds };
}

/** Apply an upsert plan atomically (single transaction). */
export interface UpsertPlanDto {
  room: DbRecord<OrpgRoom>;
  manifest: DbRecord<OrpgManifest>;
  characters: DbRecord<unknown>[];
  messages: DbRecord<unknown>[];
  items: DbRecord<unknown>[];
}

export async function applyUpsertPlan(plan: UpsertPlanDto): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put(plan.room);
      store.put(plan.manifest);
      for (const c of plan.characters) store.put(c);
      for (const m of plan.messages) store.put(m);
      for (const i of plan.items) store.put(i);

      const masterReq = store.get('v3:master:rooms');
      masterReq.onsuccess = () => {
        const master = masterReq.result as
          | { value: { roomIds: string[] }; key: string }
          | undefined;
        const roomId = plan.room.value.id;
        if (master?.value) {
          if (!master.value.roomIds.includes(roomId)) {
            master.value.roomIds.push(roomId);
            store.put(master);
          }
        } else {
          store.put({
            value: { roomIds: [roomId] },
            key: 'v3:master:rooms',
          });
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('upsert failed'));
      tx.onabort = () => reject(tx.error ?? new Error('upsert aborted'));
    });
  } finally {
    db.close();
  }
}

/** Remove one room and its manifest records from IndexedDB. */
export async function deleteRoom(roomId: string): Promise<void> {
  const all = await readAllRecords();
  const manifest = all.get(`v3:manifest:${roomId}`) as
    | DbRecord<OrpgManifest>
    | undefined;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.delete(`v3:room:${roomId}`);
      store.delete(`v3:manifest:${roomId}`);
      for (const id of manifest?.value.characterIds ?? [])
        store.delete(`v3:character:${id}`);
      for (const id of manifest?.value.messageIds ?? [])
        store.delete(`v3:message:${id}`);
      for (const id of manifest?.value.itemIds ?? []) store.delete(`v3:item:${id}`);

      const masterReq = store.get('v3:master:rooms');
      masterReq.onsuccess = () => {
        const master = masterReq.result as
          | { value: { roomIds: string[] }; key: string }
          | undefined;
        if (master?.value) {
          master.value.roomIds = master.value.roomIds.filter((r) => r !== roomId);
          store.put(master);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('delete failed'));
    });
  } finally {
    db.close();
  }
}
