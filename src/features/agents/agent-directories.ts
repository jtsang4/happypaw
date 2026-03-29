import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../app/config.js';

export function ensureAgentDirectories(
  folder: string,
  agentId: string,
): string {
  const agentIpcDir = path.join(DATA_DIR, 'ipc', folder, 'agents', agentId);
  fs.mkdirSync(path.join(agentIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'agents'), { recursive: true });
  fs.mkdirSync(
    path.join(DATA_DIR, 'sessions', folder, 'agents', agentId, '.codex'),
    { recursive: true },
  );
  return agentIpcDir;
}
