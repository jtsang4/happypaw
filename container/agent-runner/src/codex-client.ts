import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

const HAPPYPAW_CODEX_EXECUTABLE_ENV = 'HAPPYPAW_CODEX_EXECUTABLE';

export interface CodexJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexJsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface CodexJsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface PendingRequest {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
}

function createRpcError(method: string, error: CodexJsonRpcError): Error {
  const detail =
    error.data === undefined ? '' : ` (${JSON.stringify(error.data)})`;
  return new Error(`${method} failed: ${error.message}${detail}`);
}

function resolveManagedCodexExecutablePath(env: NodeJS.ProcessEnv | undefined): string {
  const executablePath = env?.[HAPPYPAW_CODEX_EXECUTABLE_ENV]?.trim();
  if (!executablePath) {
    throw new Error(
      `Missing ${HAPPYPAW_CODEX_EXECUTABLE_ENV}; HappyPaw requires a managed pinned Codex executable path.`,
    );
  }
  return executablePath;
}

export class CodexAppServerClient {
  private readonly proc: ChildProcessWithoutNullStreams;

  private readonly pending = new Map<number, PendingRequest>();

  private onNotification: (notification: CodexJsonRpcNotification) => void;

  private onRequest:
    | ((request: CodexJsonRpcRequest) => Promise<unknown> | unknown)
    | null;

  private readonly log: (message: string) => void;

  private nextId = 1;

  private stdoutBuffer = '';

  private closed = false;

  constructor(options: {
    env?: NodeJS.ProcessEnv;
    log: (message: string) => void;
    onNotification: (notification: CodexJsonRpcNotification) => void;
    onRequest?: (request: CodexJsonRpcRequest) => Promise<unknown> | unknown;
  }) {
    this.log = options.log;
    this.onNotification = options.onNotification;
    this.onRequest = options.onRequest ?? null;
    const executablePath = resolveManagedCodexExecutablePath(options.env);
    this.log(`[codex-app-server] executable=${executablePath}`);
    this.proc = spawn(executablePath, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });
    this.proc.stderr.on('data', (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed) {
        this.log(`[codex-app-server] ${trimmed}`);
      }
    });
    this.proc.on('close', (code, signal) => {
      this.closed = true;
      const reason = `codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`${pending.method}: ${reason}`));
      }
      this.pending.clear();
    });
    this.proc.on('error', (error) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<unknown> {
    const result = await this.request('initialize', {
      clientInfo: {
        name: 'happypaw_agent_runner',
        title: 'HappyPaw Agent Runner',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: false,
      },
    });
    this.notify('initialized');
    return result;
  }

  setNotificationHandler(
    handler: (notification: CodexJsonRpcNotification) => void,
  ): void {
    this.onNotification = handler;
  }

  setRequestHandler(
    handler: (request: CodexJsonRpcRequest) => Promise<unknown> | unknown,
  ): void {
    this.onRequest = handler;
  }

  notify(method: string, params?: unknown): void {
    this.writeMessage(
      params === undefined ? { method } : { method, params },
    );
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('codex app-server is not running'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.writeMessage(
        params === undefined ? { id, method } : { id, method, params },
      );
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.proc.stdin.end();
    this.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.proc.kill('SIGKILL');
      }, 1000);
      this.proc.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private writeMessage(message: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIdx = this.stdoutBuffer.indexOf('\n');
      if (newlineIdx === -1) break;
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        this.handleMessage(message);
      } catch (error) {
        this.log(
          `Failed to parse codex app-server message: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (
      typeof message.method === 'string' &&
      (typeof message.id === 'number' || typeof message.id === 'string')
    ) {
      this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error && typeof message.error === 'object') {
        pending.reject(
          createRpcError(pending.method, message.error as CodexJsonRpcError),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (typeof message.method === 'string') {
      this.onNotification({
        method: message.method,
        params: message.params,
      });
    }
  }

  private handleServerRequest(request: CodexJsonRpcRequest): void {
    if (!this.onRequest) {
      this.writeMessage({
        id: request.id,
        error: {
          code: -32601,
          message: `No handler registered for ${request.method}`,
        },
      });
      return;
    }

    Promise.resolve(this.onRequest(request))
      .then((result) => {
        this.writeMessage({
          id: request.id,
          result: result ?? {},
        });
      })
      .catch((error) => {
        this.writeMessage({
          id: request.id,
          error: {
            code: -32000,
            message:
              error instanceof Error ? error.message : String(error),
          },
        });
      });
  }
}
