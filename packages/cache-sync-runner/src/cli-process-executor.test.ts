import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCliExecutor, type CliExecutorOptions } from './cli-process-executor.js';

interface FakeChild extends EventEmitter {
  stdout: PassThrough | null;
  kill: jest.Mock<boolean, [NodeJS.Signals]>;
}

function fakeChild(captureOutput = true): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = captureOutput ? new PassThrough() : null;
  child.kill = jest.fn((_signal: NodeJS.Signals) => true);
  return child;
}

function executorOptions(child: FakeChild): CliExecutorOptions {
  return {
    cliPath: '/compiled-cli.js',
    env: {},
    spawnChild: (() => child) as unknown as NonNullable<CliExecutorOptions['spawnChild']>,
  };
}

test('captures status output and resolves nonzero child exits', async () => {
  const child = fakeChild();
  const executor = createCliExecutor(executorOptions(child));
  const result = executor.execute(['cache', 'status'], true);
  child.stdout?.end('{"status":"ready"}');
  child.emit('close', 1);
  await expect(result).resolves.toEqual({ code: 1, output: '{"status":"ready"}' });
});

test('does not propagate DEBUG into production CLI children', async () => {
  const child = fakeChild();
  let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
  const executor = createCliExecutor({
    cliPath: '/compiled-cli.js',
    env: { DEBUG: 'true', SALESBINDER_ACCOUNT_NAME: 'configured-account' },
    spawnChild: ((_executable: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawnedEnvironment = options.env;
      return child;
    }) as unknown as NonNullable<CliExecutorOptions['spawnChild']>,
  });
  const running = executor.execute(['cache', 'status'], true);
  child.emit('close', 0);
  await running;
  expect(spawnedEnvironment).toEqual({ SALESBINDER_ACCOUNT_NAME: 'configured-account' });
});

test('forwards shutdown signal to an active child', async () => {
  const child = fakeChild();
  child.kill.mockImplementation((signal) => {
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  });
  const executor = createCliExecutor(executorOptions(child));
  const running = executor.execute(['cache', 'sync'], false);
  executor.stop('SIGINT');
  await running;
  expect(child.kill).toHaveBeenCalledWith('SIGINT');
});

test('force-kills a child that ignores the forwarded signal', async () => {
  const child = fakeChild();
  child.kill.mockImplementation((signal) => {
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal));
    return true;
  });
  const executor = createCliExecutor({
    ...executorOptions(child),
    schedule: (callback) => setImmediate(callback),
    cancelSchedule: (handle) => clearImmediate(handle as NodeJS.Immediate),
  });
  const running = executor.execute(['cache', 'sync'], false);
  executor.stop('SIGTERM');
  await running;
  expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
});
