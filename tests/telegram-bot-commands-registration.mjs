#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';

const { TELEGRAM_BOT_COMMANDS, registerTelegramBotCommands } = await import(
  path.join(
    repoRoot,
    'dist',
    'features',
    'im',
    'channels',
    'telegram',
    'bot-commands.js',
  )
);

const calls = [];
await registerTelegramBotCommands({
  async setMyCommands(commands) {
    calls.push(commands);
    return true;
  },
});

assert.equal(calls.length, 1, 'expected one setMyCommands call');
assert.deepEqual(
  calls[0],
  TELEGRAM_BOT_COMMANDS,
  'registered commands should match the exported Telegram command list',
);
assert.ok(
  TELEGRAM_BOT_COMMANDS.some((item) => item.command === 'bind'),
  'expected bind command to be exposed to Telegram',
);
assert.ok(
  TELEGRAM_BOT_COMMANDS.some((item) => item.command === 'new'),
  'expected new command to be exposed to Telegram',
);

console.log('telegram bot command registration regression passed');
