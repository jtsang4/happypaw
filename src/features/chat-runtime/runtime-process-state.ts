import type {
  MessageCursor,
  RegisteredGroup,
  RuntimeSessionRecord,
} from '../../shared/types.js';
import { GroupQueue } from './group-queue.js';

export function createRuntimeProcessState() {
  let globalMessageCursor: MessageCursor = { timestamp: '', id: '' };
  let shuttingDown = false;
  let stuckRunnerCheckCounter = 0;

  return {
    sessions: {} as Record<string, RuntimeSessionRecord>,
    registeredGroups: {} as Record<string, RegisteredGroup>,
    lastAgentTimestamp: {} as Record<string, MessageCursor>,
    lastCommittedCursor: {} as Record<string, MessageCursor>,
    shutdownSavedJids: new Set<string>(),
    queue: new GroupQueue(),
    terminalWarmupInFlight: new Set<string>(),
    consecutiveOomExits: {} as Record<string, number>,
    getGlobalMessageCursor: () => globalMessageCursor,
    setGlobalMessageCursor: (cursor: MessageCursor) => {
      globalMessageCursor = cursor;
    },
    isShuttingDown: () => shuttingDown,
    setShuttingDown: (value: boolean) => {
      shuttingDown = value;
    },
    getStuckRunnerCheckCounter: () => stuckRunnerCheckCounter,
    resetStuckRunnerCheckCounter: () => {
      stuckRunnerCheckCounter = 0;
    },
    incrementStuckRunnerCheckCounter: () => ++stuckRunnerCheckCounter,
  };
}
