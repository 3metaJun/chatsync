/**
 * Content script on openrouter.ai. Bridges background sync requests to the
 * page's IndexedDB (`openrouter:playground:v3`), which the isolated world
 * shares with the page origin.
 */
import { CS_VERSION, type CsRequest, type CsResponse } from '@/lib/messaging';
import { planUpsert } from '@/lib/orpg';
import { applyUpsertPlan, deleteRoom, readAllRecords, readLocalSnapshot } from '@/lib/playground-db';
import type { OrpgExport, OrpgRoom } from '@/lib/types';
import type { DbRecord } from '@/lib/types';

export default defineContentScript({
  matches: ['https://openrouter.ai/*'],
  runAt: 'document_idle',

  main() {
    chrome.runtime.onMessage.addListener(
      (msg: CsRequest, _sender, sendResponse: (res: CsResponse) => void) => {
        switch (msg.type) {
          case 'cs:ping':
            sendResponse({ type: 'pong', v: CS_VERSION });
            break;

          case 'cs:readSnapshot':
            readLocalSnapshot()
              .then(({ rooms, roomIds }) =>
                sendResponse({ type: 'snapshot', rooms, roomIds }),
              )
              .catch((e: unknown) =>
                sendResponse({
                  type: 'error',
                  message: e instanceof Error ? e.message : String(e),
                }),
              );
            break;

          case 'cs:apply': {
            (async () => {
              const all = await readAllRecords();
              const existing = all.get(`v3:room:${msg.roomId}`) as
                | DbRecord<OrpgRoom>
                | undefined;
              const now = new Date().toISOString();
              const plan = planUpsert(
                msg.data as OrpgExport,
                msg.roomId,
                now,
                existing,
              );
              await applyUpsertPlan(plan);
              sendResponse({ type: 'applied' });
            })().catch((e: unknown) =>
              sendResponse({
                type: 'error',
                message: e instanceof Error ? e.message : String(e),
              }),
            );
            break;
          }

          case 'cs:deleteRoom':
            deleteRoom(msg.roomId)
              .then(() => sendResponse({ type: 'deleted' }))
              .catch((e: unknown) =>
                sendResponse({
                  type: 'error',
                  message: e instanceof Error ? e.message : String(e),
                }),
              );
            break;

          case 'cs:reload':
            sendResponse({ type: 'reloading' });
            setTimeout(() => window.location.reload(), 150);
            break;

          default:
            break;
        }
        return true; // async
      },
    );
  },
});
