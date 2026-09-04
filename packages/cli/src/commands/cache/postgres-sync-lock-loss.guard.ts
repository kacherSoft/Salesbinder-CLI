import { PostgresSyncLockLostError } from '@salesbinder/sdk';

export type SyncLockLossGuard = {
  signal: AbortSignal;
  onLost: (error: Error) => void;
  assertHeld: () => void;
  isLost: () => boolean;
  safeError: (error: unknown) => Error;
};

export function createSyncLockLossGuard(): SyncLockLossGuard {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  return {
    signal: controller.signal,
    onLost: abort,
    assertHeld: () => {
      if (controller.signal.aborted) throw new PostgresSyncLockLostError();
    },
    isLost: () => controller.signal.aborted,
    safeError: (error) =>
      controller.signal.aborted
        ? new PostgresSyncLockLostError()
        : error instanceof Error
          ? error
          : new Error(String(error)),
  };
}

export async function awaitWhileSyncLockHeld<T>(
  lockLoss: SyncLockLossGuard | null,
  operation: () => Promise<T>
): Promise<T> {
  if (!lockLoss) return operation();

  lockLoss.assertHeld();
  const operationPromise = Promise.resolve().then(operation);
  let removeAbortListener = (): void => undefined;
  const lockLost = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(new PostgresSyncLockLostError());
    lockLoss.signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => lockLoss.signal.removeEventListener('abort', onAbort);
    if (lockLoss.signal.aborted) onAbort();
  });

  try {
    const result = await Promise.race([operationPromise, lockLost]);
    lockLoss.assertHeld();
    return result;
  } finally {
    removeAbortListener();
  }
}
