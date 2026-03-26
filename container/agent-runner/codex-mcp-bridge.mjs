#!/usr/bin/env node

import process from 'node:process';

const lines = [];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(text) {
  return {
    content: [{ type: 'text', text }],
  };
}

function buildContextText() {
  return [
    `groupFolder=${process.env.HAPPYPAW_GROUP_FOLDER || ''}`,
    `workspace=${process.env.HAPPYPAW_WORKSPACE_GROUP || ''}`,
    `ownerId=${process.env.HAPPYPAW_OWNER_ID || ''}`,
    `runtime=${process.env.HAPPYPAW_RUNTIME || ''}`,
    `productId=${process.env.HAPPYPAW_PRODUCT_ID || ''}`,
  ].join('\n');
}

const toolDefinitions = [
  {
    name: 'get_context',
    description:
      'Return bridge context sourced from process environment variables.',
    inputSchema: { type: 'object', properties: {} },
  },
];

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  lines.push(...chunk.split('\n'));
  while (lines.length > 1) {
    const raw = lines.shift();
    if (!raw || !raw.trim()) continue;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }

    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'happypaw-codex-bridge',
            version: '1.0.0',
          },
        },
      });
      continue;
    }

    if (message.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: toolDefinitions },
      });
      continue;
    }

    if (message.method === 'tools/call') {
      const toolName = message.params?.name;
      if (toolName === 'get_context') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: toolResult(buildContextText()),
        });
      } else {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `Unknown tool: ${toolName}`,
          },
        });
      }
      continue;
    }

    if (message.id !== undefined) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unsupported method: ${message.method}` },
      });
    }
  }
});
