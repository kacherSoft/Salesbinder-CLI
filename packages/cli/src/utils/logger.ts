/**
 * Simple logger for CLI output
 */

export enum LogLevel {
  ERROR = 'ERROR',
  WARN = 'WARN',
  INFO = 'INFO',
}

/** Logger interface */
export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
}

/** Console logger implementation */
export class ConsoleLogger implements Logger {
  error(message: string): void {
    console.error(JSON.stringify({ level: LogLevel.ERROR, message }));
  }

  warn(message: string): void {
    console.warn(JSON.stringify({ level: LogLevel.WARN, message }));
  }

  info(message: string): void {
    console.info(JSON.stringify({ level: LogLevel.INFO, message }));
  }
}

/** Silent logger (for tests) */
export class SilentLogger implements Logger {
  error(): void {}
  warn(): void {}
  info(): void {}
}
