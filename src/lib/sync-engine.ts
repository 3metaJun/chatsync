/**
 * Sync engine: pure orchestration with injected I/O.
 *
 * Strategy
 *  - Per-room diff against the remote manifest (content hash).
 *  - Conflicts resolved last-write-wins by `room.updatedAt` (maintained by
 *    OpenRouter itself on every message change).
 *  - Deletions propagate via tombstones on BOTH sides:
 *      local delete  -> local tombstone -> remove remote file + manifest
 *                       entry + manifest.deleted[id] = deletedAt
 *      remote delete -> manifest.deleted -> remove local room unless the
 *                       local copy is newer (resurrect -> push back)
 *  - A null remote manifest (never initialized / fresh backend) never
 *    deletes anything; everything local is pushed.
 */
import type { SyncAdapter } from './adapters/types';
import { emptySyncManifest, type LocalRoomSnapshot, type OrpgExport, type SyncManifest, type SyncReport, type Tombstone } from './types';
import { emptySyncReport } from './types';
import { hashExport, stripModelInfo } from './orpg';

export interface LocalSyncState {
  lastSeenRoomIds: string[];
  localTombstones: Tombstone[];
}

export interface SyncDeps {
  adapter: SyncAdapter;
  stripModelInfo: boolean;
  readLocal(): Promise<{ rooms: LocalRoomSnapshot[]; roomIds: string[] }>;
  applyRoom(roomId: string, data: OrpgExport): Promise<void>;
  deleteLocalRoom(roomId: string): Promise<void>;
  getLocalState(): Promise<LocalSyncState>;
  setLocalState(state: LocalSyncState): Promise<void>;
}

const roomFile = (roomId: string) => `rooms/${roomId}.json`;

/** Hash of the configured view of an export (strip-aware, manifest-stable). */
async function viewHash(
  deps: SyncDeps,
  data: OrpgExport,
): Promise<string> {
  return hashExport(deps.stripModelInfo ? stripModelInfo(data) : data);
}

async function parseManifest(text: string | null): Promise<SyncManifest | null> {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as SyncManifest;
    if (parsed?.format !== 'orpg-sync' || parsed.version !== 1) return null;
    return { ...emptySyncManifest(), ...parsed, deleted: parsed.deleted ?? {} };
  } catch {
    throw new Error('Remote manifest.json is not valid JSON.');
  }
}

export async function runSync(deps: SyncDeps): Promise<SyncReport> {
  const report = emptySyncReport();
  const { adapter } = deps;

  const manifestText = await adapter.getManifest();
  const remote = await parseManifest(manifestText);
  const remoteExists = remote !== null;
  const manifest: SyncManifest = remote ?? emptySyncManifest();

  const { rooms: localRooms, roomIds } = await deps.readLocal();
  const local = new Map(localRooms.map((r) => [r.room.id, r]));
  const state = await deps.getLocalState();

  // ---- detect local deletions since last sync --------------------------
  const seen = new Set(state.lastSeenRoomIds);
  for (const roomId of roomIds) seen.add(roomId);
  const newlyDeletedLocally = state.lastSeenRoomIds.filter(
    (id) => !roomIds.includes(id),
  );
  const tombstones = new Map(
    state.localTombstones.map((t) => [t.roomId, t.deletedAt]),
  );
  const now = new Date().toISOString();
  for (const id of newlyDeletedLocally) {
    if (!tombstones.has(id)) tombstones.set(id, now);
  }

  // ---- pass 1: remote deletions -> apply locally ------------------------
  for (const [roomId, deletedAt] of Object.entries(manifest.deleted)) {
    const l = local.get(roomId);
    if (!l) continue;
    if (l.room.updatedAt > deletedAt) {
      // Local copy is newer than the deletion: resurrect by pushing back.
      report.conflicts.push({ roomId, resolution: 'local' });
      continue;
    }
    await deps.deleteLocalRoom(roomId);
    local.delete(roomId);
    seen.delete(roomId);
    report.deletedRemote.push(roomId);
  }

  // ---- pass 2: per-room diff -------------------------------------------
  const allIds = new Set<string>([...local.keys(), ...Object.keys(manifest.rooms)]);
  for (const roomId of allIds) {
    const l = local.get(roomId);
    const r = manifest.rooms[roomId];
    try {
      if (!r && l) {
        // New or resurrected locally (or remote file lost): push.
        const tombstoneDeletedAt = tombstones.get(roomId);
        if (remoteExists && tombstoneDeletedAt && l.room.updatedAt <= tombstoneDeletedAt) {
          // Deleted locally and never changed elsewhere: propagate deletion.
          await adapter.deleteFile(roomFile(roomId));
          delete manifest.rooms[roomId];
          manifest.deleted[roomId] = tombstoneDeletedAt;
          tombstones.delete(roomId);
          seen.delete(roomId);
          report.deletedRemote.push(roomId);
        } else {
          await pushRoom(deps, manifest, l);
          report.pushed.push(roomId);
          tombstones.delete(roomId);
        }
      } else if (r && !l) {
        // Exists remotely, not locally.
        const tombstoneDeletedAt = tombstones.get(roomId);
        if (tombstoneDeletedAt && r.updatedAt <= tombstoneDeletedAt) {
          // Deleted here, remote copy unchanged: remove from remote.
          await adapter.deleteFile(roomFile(roomId));
          delete manifest.rooms[roomId];
          manifest.deleted[roomId] = tombstoneDeletedAt;
          tombstones.delete(roomId);
          seen.delete(roomId);
          report.deletedRemote.push(roomId);
        } else {
          const text = await adapter.getFile(roomFile(roomId));
          if (!text) {
            // Manifest entry exists but file missing: clean the manifest.
            delete manifest.rooms[roomId];
          } else {
            const data = JSON.parse(text) as OrpgExport;
            await deps.applyRoom(roomId, data);
            seen.add(roomId); // pulled rooms must count as seen
            report.pulled.push(roomId);
          }
          tombstones.delete(roomId);
        }
      } else if (r && l) {
        const lHash = await viewHash(deps, l.data);
        if (lHash === r.hash) {
          report.skipped++;
        } else if (l.room.updatedAt >= r.updatedAt) {
          await pushRoom(deps, manifest, l);
          report.pushed.push(roomId);
          if (l.room.updatedAt === r.updatedAt)
            report.conflicts.push({ roomId, resolution: 'local' });
        } else {
          const text = await adapter.getFile(roomFile(roomId));
          if (text) {
            const data = JSON.parse(text) as OrpgExport;
            await deps.applyRoom(roomId, data);
            report.pulled.push(roomId);
            report.conflicts.push({ roomId, resolution: 'remote' });
          }
        }
      }
    } catch (e) {
      report.errors.push(`${roomId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- persist manifest + local state ----------------------------------
  manifest.updatedAt = new Date().toISOString();
  if (remoteExists || Object.keys(manifest.rooms).length > 0) {
    await adapter.putFile(
      'manifest.json',
      JSON.stringify(manifest, null, 2),
    );
  }

  await deps.setLocalState({
    lastSeenRoomIds: [...seen],
    localTombstones: [...tombstones.entries()].map(([roomId, deletedAt]) => ({
      roomId,
      deletedAt,
    })),
  });

  report.finishedAt = new Date().toISOString();
  return report;
}

async function pushRoom(
  deps: SyncDeps,
  manifest: SyncManifest,
  snap: LocalRoomSnapshot,
): Promise<void> {
  const payload = deps.stripModelInfo ? stripModelInfo(snap.data) : snap.data;
  await deps.adapter.putFile(
    roomFile(snap.room.id),
    JSON.stringify(payload, null, 2),
  );
  manifest.rooms[snap.room.id] = {
    title: snap.room.title,
    updatedAt: snap.room.updatedAt,
    hash: await hashExport(payload),
  };
  delete manifest.deleted[snap.room.id];
}

/** Hash used by the engine, exported for tests. */
export { hashExport };
