import { spawn, type ChildProcess } from 'node:child_process';

export interface CommandResult {
  code: number;
  output: string;
  errorOutput?: string;
}

export interface CliExecutor {
  execute(args: string[], captureOutput: boolean): Promise<CommandResult>;
  stop(signal?: NodeJS.Signals): void;
}

type ChildLike = Pick<ChildProcess, 'kill' | 'once' | 'stdout' | 'stderr'>;
type SpawnChild = (
  executable: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: 'inherit' | ['ignore', 'pipe', 'pipe'];
  }
) => ChildLike;

export interface CliExecutorOptions {
  cliPath: string;
  env: NodeJS.ProcessEnv;
  spawnChild?: SpawnChild;
  schedule?: (callback: () => void, milliseconds: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  shutdownGraceMilliseconds?: number;
}

export function createCliExecutor(options: CliExecutorOptions): CliExecutor {
  const spawnChild = options.spawnChild ?? (spawn as SpawnChild);
  const childEnvironment = { ...options.env };
  delete childEnvironment.DEBUG;
  const schedule =
    options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const cancelSchedule =
    options.cancelSchedule ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const shutdownGraceMilliseconds = options.shutdownGraceMilliseconds ?? 10_000;
  let activeChild: ChildLike | null = null;
  let forcedStop: unknown | null = null;

  return {
    execute(args: string[], captureOutput: boolean): Promise<CommandResult> {
      return new Promise((resolve) => {
        let output = '';
        let errorOutput = '';
        let settled = false;
        const child = spawnChild(process.execPath, [options.cliPath, ...args], {
          env: childEnvironment,
          stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        });
        activeChild = child;
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string | Buffer) => {
          output = `${output}${chunk}`.slice(0, 1_048_576);
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string | Buffer) => {
          const text = String(chunk);
          // Progress can be long-lived; retain the terminal diagnostic JSON rather than its oldest logs.
          errorOutput = `${errorOutput}${text}`.slice(-1_048_576);
          process.stderr.write(text);
        });
        const finish = (code: number): void => {
          if (settled) return;
          settled = true;
          if (forcedStop !== null) cancelSchedule(forcedStop);
          forcedStop = null;
          if (activeChild === child) activeChild = null;
          resolve({ code, output, errorOutput });
        };
        child.once('error', () => finish(1));
        child.once('close', (code) => finish(code ?? 1));
      });
    },
    stop(signal: NodeJS.Signals = 'SIGTERM'): void {
      const child = activeChild;
      if (!child) return;
      if (forcedStop !== null) cancelSchedule(forcedStop);
      forcedStop = schedule(() => {
        if (activeChild === child) child.kill('SIGKILL');
      }, shutdownGraceMilliseconds);
      child.kill(signal);
    },
  };
}
