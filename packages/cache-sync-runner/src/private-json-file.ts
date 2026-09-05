import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface PrivateJsonDependencies {
  fileSystem?: Pick<
    typeof fs,
    'chmodSync' | 'mkdirSync' | 'renameSync' | 'rmSync' | 'writeFileSync'
  >;
  uniqueId?: () => string;
}

export function writePrivateJson(
  targetPath: string,
  value: unknown,
  dependencies: PrivateJsonDependencies = {}
): void {
  const fileSystem = dependencies.fileSystem ?? fs;
  const uniqueId = dependencies.uniqueId ?? randomUUID;
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${uniqueId()}.tmp`
  );
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fileSystem.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fileSystem.renameSync(temporaryPath, targetPath);
    fileSystem.chmodSync(targetPath, 0o600);
  } finally {
    fileSystem.rmSync(temporaryPath, { force: true });
  }
}
