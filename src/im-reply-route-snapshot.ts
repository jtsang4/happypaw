import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

export const ACTIVE_IM_REPLY_ROUTE_FILE = 'active_im_reply_route.json';

export function getActiveImReplyRouteSnapshotPath(folder: string): string {
  return path.join(DATA_DIR, 'ipc', folder, ACTIVE_IM_REPLY_ROUTE_FILE);
}

export function getScopedImReplyRouteSnapshotPath(ipcDir: string): string {
  return path.join(ipcDir, ACTIVE_IM_REPLY_ROUTE_FILE);
}

export function persistActiveImReplyRouteSnapshot(
  snapshotPath: string,
  replyJid: string | null,
): void {
  if (!replyJid) {
    try {
      fs.unlinkSync(snapshotPath);
    } catch {
      /* ignore */
    }
    return;
  }

  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const tempPath = `${snapshotPath}.tmp`;
  fs.writeFileSync(
    tempPath,
    JSON.stringify(
      {
        replyJid,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tempPath, snapshotPath);
}

export function persistActiveImReplyRouteForIpcDir(
  ipcDir: string,
  replyJid: string | null,
): void {
  persistActiveImReplyRouteSnapshot(
    getScopedImReplyRouteSnapshotPath(ipcDir),
    replyJid,
  );
}

export function readActiveImReplyRouteSnapshot(
  snapshotPath: string,
): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
      replyJid?: unknown;
    };
    return typeof parsed.replyJid === 'string' && parsed.replyJid.trim()
      ? parsed.replyJid.trim()
      : null;
  } catch {
    return null;
  }
}

export function readActiveImReplyRouteForIpcDir(ipcDir: string): string | null {
  return readActiveImReplyRouteSnapshot(
    getScopedImReplyRouteSnapshotPath(ipcDir),
  );
}
