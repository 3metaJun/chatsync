import { useCallback, useEffect, useState } from 'react';
import type { BgStatus } from '@/lib/messaging';
import type { SyncReport } from '@/lib/types';
import { sendMessage } from '@/lib/webext';

type RunState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; report: SyncReport }
  | { phase: 'error'; message: string };

/** sendMessage with a hard timeout + rejection so UI never hangs forever. */
const send = sendMessage;

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function backendLabel(backend: BgStatus['backend']): string {
  if (backend === 'github') return 'GitHub';
  if (backend === 'webdav') return 'WebDAV';
  return 'not configured';
}

export default function App() {
  const [status, setStatus] = useState<BgStatus | null>(null);
  const [run, setRun] = useState<RunState>({ phase: 'idle' });

  useEffect(() => {
    const load = () =>
      send<{ ok: boolean; status: BgStatus }>({ type: 'sync:status' }).then((r) =>
        setStatus(r.status),
      );
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  const syncNow = useCallback(async () => {
    setRun({ phase: 'running' });
    try {
      const res = await send<{ ok: boolean; report?: SyncReport; error?: string }>({
        type: 'sync:run',
      });
      if (res.ok && res.report) setRun({ phase: 'done', report: res.report });
      else setRun({ phase: 'error', message: res.error ?? 'sync failed' });
      const s = await send<{ ok: boolean; status: BgStatus }>({ type: 'sync:status' });
      setStatus(s.status);
    } catch (e) {
      setRun({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const openOptions = () => chrome.runtime.openOptionsPage();

  const report =
    run.phase === 'done' ? run.report : (status?.lastReport ?? null);
  const busy = run.phase === 'running' || (status?.syncing ?? false);

  return (
    <div className="w-80 p-3 text-sm">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold tracking-wide">CHATSYNC</span>
        <button
          onClick={openOptions}
          className="text-neutral-400 hover:text-white"
          title="Settings"
        >
          settings
        </button>
      </div>

      <div className="mt-3 space-y-1 font-mono text-xs text-neutral-300">
        <div className="flex justify-between">
          <span>backend</span>
          <span className={status?.configured ? 'text-white' : 'text-red-400'}>
            {backendLabel(status?.backend ?? null)}
            {status?.configured ? '' : ' (unset)'}
          </span>
        </div>
        <div className="flex justify-between">
          <span>last sync</span>
          <span>{relTime(status?.lastSyncedAt ?? null)}</span>
        </div>
        {report && (
          <div className="flex justify-between">
            <span>rooms</span>
            <span>
              {report.pushed.length} up · {report.pulled.length} down ·{' '}
              {report.deletedRemote.length} del · {report.skipped} same
            </span>
          </div>
        )}
      </div>

      <button
        onClick={syncNow}
        disabled={busy || !status?.configured}
        className="mt-4 w-full border border-neutral-700 px-3 py-2 text-sm font-medium hover:bg-neutral-900 disabled:opacity-40"
      >
        {busy ? 'syncing…' : 'sync now'}
      </button>

      {run.phase === 'error' && (
        <p className="mt-2 font-mono text-xs text-red-400">{run.message}</p>
      )}

      {run.phase === 'done' && run.report.errors.length > 0 && (
        <p className="mt-2 font-mono text-xs text-red-400">
          {run.report.errors.length} room error(s)
        </p>
      )}

      {!status?.configured && (
        <button
          onClick={openOptions}
          className="mt-2 w-full px-3 py-2 text-xs text-neutral-400 underline underline-offset-2 hover:text-white"
        >
          configure a sync backend first
        </button>
      )}

      {report && report.conflicts.length > 0 && (
        <p className="mt-2 font-mono text-xs text-neutral-500">
          {report.conflicts.length} conflict(s) resolved by newest
        </p>
      )}
    </div>
  );
}
