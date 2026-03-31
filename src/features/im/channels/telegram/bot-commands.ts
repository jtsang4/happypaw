export interface TelegramBotCommandDefinition {
  command: string;
  description: string;
}

export const TELEGRAM_BOT_COMMANDS: readonly TelegramBotCommandDefinition[] = [
  { command: 'start', description: 'Show connection help' },
  { command: 'pair', description: 'Pair this chat with HappyPaw' },
  { command: 'list', description: 'List available workspaces' },
  { command: 'where', description: 'Show the current binding target' },
  { command: 'status', description: 'Show the current workspace status' },
  { command: 'bind', description: 'Bind this chat to a workspace or agent' },
  {
    command: 'unbind',
    description: 'Return this chat to its default workspace',
  },
  { command: 'new', description: 'Create a workspace and bind this chat' },
  {
    command: 'require_mention',
    description: 'Toggle mention-only replies in groups',
  },
  { command: 'clear', description: 'Clear the current conversation session' },
  { command: 'spawn', description: 'Create a parallel task in this workspace' },
] as const;

interface TelegramBotCommandsApi {
  setMyCommands(
    commands: readonly TelegramBotCommandDefinition[],
  ): Promise<unknown>;
}

export async function registerTelegramBotCommands(
  api: TelegramBotCommandsApi,
): Promise<void> {
  await api.setMyCommands(TELEGRAM_BOT_COMMANDS);
}
