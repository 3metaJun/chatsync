import { describe, expect, it } from 'vitest';
import { runSync, type LocalSyncState, type SyncDeps } from './sync-engine';
import type { LocalRoomSnapshot, OrpgExport, SyncManifest } from './types';
import type { SyncAdapter } from './adapters/types';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const mkExport = (title: string, text: string): OrpgExport => ({
  version: 'orpg.3.0',
  title,
  characters: {
    'char-1': {
      id: 'char-1',
      model: 'test/model',
      modelInfo: { slug: 'test/model', name: 'Test', description: 'x'.repeat(5000) },
    },
  },
  messages: {
    'msg-1': {
      id: 'msg-1',
      characterId: 'USER',
      contentType: 'text',
      context: 'main-chat',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      isRetrying: false,
      isEdited: false,
      isCollapsed: false,
      type: 'user',
      items: [{ id: 'item-1', type: 'message' }],
    },
    'msg-2': {
      id: 'msg-2',
      characterId: 'char-1',
      contentType: 'text',
      context: 'main-chat',
      parentMessageId: 'msg-1',
      createdAt: '2026-08-01T00:00:01.000Z',
      updatedAt: '2026-08-01T00:00:01.000Z',
      isRetrying: false,
      isEdited: false,
      isCollapsed: false,
      type: 'assistant',
      items: [{ id: 'item-2', type: 'message' }],
    },
  },
  items: {
    'item-1': {
      id: 'item-1',
      messageId: 'msg-1',
      data: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    },
    'item-2': {
      id: 'item-2',
      messageId: 'msg-2',
      data: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply', annotations: [] }] },
    },
  },
  artifacts: {},
  artifactFiles: {},
  artifactVersions: {},
  artifactFileContents: {},
});

const mkSnapshot = (
  roomId: string,
  title: string,
  updatedAt: string,
  text = 'hello',
): LocalRoomSnapshot => ({
  room: {
    id: roomId,
    title,
    createdAt: updatedAt,
    updatedAt,
    version: 3,
    isPinned: false,
  },
  data: mkExport(title, text),
});

/** In-memory adapter + engine harness. */
function harness(opts?: { strip?: boolean }) {
  const files = new Map<string, string>();
  const applied: { roomId: string; data: OrpgExport }[] = [];
  const localDeleted: string[] = [];
  let localRooms = new Map<string, LocalRoomSnapshot>();
  let state: LocalSyncState = { lastSeenRoomIds: [], localTombstones: [] };

  const adapter: SyncAdapter = {
    kind: 'github',
    getManifest: async () => files.get('manifest.json') ?? null,
    putFile: async (p, t) => void files.set(p, t),
    getFile: async (p) => files.get(p) ?? null,
    deleteFile: async (p) => void files.delete(p),
    test: async () => ({ ok: true, detail: 'harness' }),
  };

  const deps: SyncDeps = {
    adapter,
    stripModelInfo: opts?.strip ?? false,
    readLocal: async () => ({
      rooms: [...localRooms.values()],
      roomIds: [...localRooms.keys()],
    }),
    applyRoom: async (roomId, data) => void applied.push({ roomId, data }),
    deleteLocalRoom: async (roomId) => void localDeleted.push(roomId),
    getLocalState: async () => state,
    setLocalState: async (s) => void (state = s),
  };

  const manifest = (): SyncManifest | null => {
    const t = files.get('manifest.json');
    return t ? (JSON.parse(t) as SyncManifest) : null;
  };

  return {
    files,
    applied,
    localDeleted,
    manifest,
    setLocalRooms: (rooms: LocalRoomSnapshot[]) => void (localRooms = new Map(rooms.map((r) => [r.room.id, r]))),
    getState: () => state,
    deps,
  };
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

describe('runSync', () => {
  it('first sync pushes all local rooms and never deletes', async () => {
    const h = harness();
    h.setLocalRooms([mkSnapshot('r1', 'one', '2026-08-01T00:00:00Z')]);
    const report = await runSync(h.deps);

    expect(report.pushed).toEqual(['r1']);
    expect(report.pulled).toEqual([]);
    expect(report.deletedRemote).toEqual([]);
    expect(h.files.get('rooms/r1.json')).toBeTruthy();
    expect(h.manifest()?.rooms['r1'].title).toBe('one');
    expect(h.getState().lastSeenRoomIds).toEqual(['r1']);
  });

  it('second sync with no changes skips everything', async () => {
    const h = harness();
    h.setLocalRooms([mkSnapshot('r1', 'one', '2026-08-01T00:00:00Z')]);
    await runSync(h.deps);
    const report = await runSync(h.deps);

    expect(report.skipped).toBe(1);
    expect(report.pushed).toEqual([]);
    expect(report.pulled).toEqual([]);
  });

  it('pulls rooms that exist only remotely', async () => {
    const h = harness();
    h.setLocalRooms([mkSnapshot('r1', 'one', '2026-08-01T00:00:00Z')]);
    await runSync(h.deps);

    // Another device created r2 remotely: put the file + manifest entry.
    const r2 = mkSnapshot('r2', 'two', '2026-08-02T00:00:00Z');
    const man = h.manifest()!;
    man.rooms['r2'] = { title: 'two', updatedAt: '2026-08-02T00:00:00Z', hash: 'stale-hash' };
    h.files.set('manifest.json', JSON.stringify(man));
    h.files.set('rooms/r2.json', JSON.stringify(r2.data));

    const report = await runSync(h.deps);
    expect(report.pulled).toEqual(['r2']);
    expect(h.applied.map((a) => a.roomId)).toEqual(['r2']);
  });

  it('resolves conflicts last-write-wins', async () => {
    const h = harness();
    h.setLocalRooms([mkSnapshot('r1', 'one', '2026-08-01T00:00:00Z')]);
    await runSync(h.deps);

    // Remote edited after our last push.
    const man = h.manifest()!;
    man.rooms['r1'] = { title: 'remote', updatedAt: '2026-08-05T00:00:00Z', hash: 'changed' };
    h.files.set('manifest.json', JSON.stringify(man));
    h.files.set('rooms/r1.json', JSON.stringify(mkExport('remote', 'remote edit')));

    // Local did NOT change (same updatedAt as first push).
    const report = await runSync(h.deps);
    expect(report.pulled).toEqual(['r1']);
    expect(report.conflicts[0]).toEqual({ roomId: 'r1', resolution: 'remote' });

    // Now local is newer than remote.
    h.setLocalRooms([mkSnapshot('r1', 'local', '2026-08-06T00:00:00Z')]);
    const report2 = await runSync(h.deps);
    expect(report2.pushed).toEqual(['r1']);
    expect(h.manifest()?.rooms['r1'].title).toBe('local');
  });

  it('propagates local deletion to remote with a tombstone', async () => {
    const h = harness();
    h.setLocalRooms([mkSnapshot('r1', 'one', '2026-08-01T00:00:00Z')]);
    await runSync(h.deps);

    // User deletes the room locally before next sync.
    h.setLocalRooms([]);
    const report = await runSync(h.deps);

    expect(report.deletedRemote).toEqual(['r1']);
    expect(h.files.has('rooms/r1.json')).toBe(false);
    expect(h.manifest()?.rooms['r1']).toBeUndefined();
    expect(h.manifest()?.deleted['r1']).toBeTruthy();
  });

  it('applies remote deletion locally', async () => {
    const h = harness();
    h.setLocalRooms([mkSnapshot('r1', 'one', '2026-08-01T00:00:00Z')]);
    await runSync(h.deps);

    // Remote tombstones r1 (deleted by another device after our push).
    const man = h.manifest()!;
    delete man.rooms['r1'];
    man.deleted['r1'] = '2026-08-09T00:00:00Z';
    h.files.set('manifest.json', JSON.stringify(man));
    h.files.delete('rooms/r1.json');

    const report = await runSync(h.deps);
    expect(report.deletedRemote).toContain('r1');
    expect(h.localDeleted).toEqual(['r1']);
  });

  it('resurrects a remotely-deleted room when the local copy is newer', async () => {
    const h = harness();
    h.setLocalRooms([mkSnapshot('r1', 'one', '2026-08-01T00:00:00Z')]);
    await runSync(h.deps);

    // Remote deletes at T2, but local was updated at T3.
    const man = h.manifest()!;
    delete man.rooms['r1'];
    man.deleted['r1'] = '2026-08-02T00:00:00Z';
    h.files.set('manifest.json', JSON.stringify(man));
    h.files.delete('rooms/r1.json');
    h.setLocalRooms([mkSnapshot('r1', 'one', '2026-08-03T00:00:00Z')]);

    const report = await runSync(h.deps);
    expect(report.pushed).toEqual(['r1']);
    expect(report.deletedRemote).toEqual([]);
    expect(h.manifest()?.rooms['r1']).toBeTruthy();
    expect(h.manifest()?.deleted['r1']).toBeUndefined();
  });

  it('propagates deletion of a previously pulled room', async () => {
    const h = harness();
    h.setLocalRooms([mkSnapshot('r1', 'one', '2026-08-01T00:00:00Z')]);
    await runSync(h.deps);

    // Remote device creates r2; this device pulls it.
    const r2 = mkSnapshot('r2', 'two', '2026-08-02T00:00:00Z');
    const man = h.manifest()!;
    man.rooms['r2'] = { title: 'two', updatedAt: '2026-08-02T00:00:00Z', hash: 'x' };
    h.files.set('manifest.json', JSON.stringify(man));
    h.files.set('rooms/r2.json', JSON.stringify(r2.data));
    const pull = await runSync(h.deps);
    expect(pull.pulled).toEqual(['r2']);
    expect(h.getState().lastSeenRoomIds).toContain('r2');

    // User deletes r2 locally; next sync must remove it from remote.
    h.setLocalRooms([mkSnapshot('r1', 'one', '2026-08-01T00:00:00Z')]);
    const del = await runSync(h.deps);
    expect(del.deletedRemote).toEqual(['r2']);
    expect(h.files.has('rooms/r2.json')).toBe(false);
    expect(h.manifest()?.deleted['r2']).toBeTruthy();
    expect(h.manifest()?.rooms['r2']).toBeUndefined();
  });

  it('strips modelInfo when configured and stays stable across syncs', async () => {
    const h = harness({ strip: true });
    h.setLocalRooms([mkSnapshot('r1', 'one', '2026-08-01T00:00:00Z')]);
    await runSync(h.deps);

    const stored = JSON.parse(h.files.get('rooms/r1.json')!) as OrpgExport;
    expect(stored.characters['char-1'].modelInfo).toBeNull();

    // No-change resync must skip (hash over the stripped view matches).
    const report = await runSync(h.deps);
    expect(report.skipped).toBe(1);
  });
});
