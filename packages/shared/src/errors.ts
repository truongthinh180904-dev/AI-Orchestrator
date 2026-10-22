export class AppError extends Error {
  public override readonly name = 'AppError';

  constructor(
    public readonly code: string,
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toJSON(): {
    name: string;
    code: string;
    message: string;
    context: Record<string, unknown>;
    stack?: string;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      ...(this.stack ? { stack: this.stack } : {}),
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  if (error instanceof AppError) {
    return true;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { name?: unknown; code?: unknown };
    return candidate.name === 'AppError' && typeof candidate.code === 'string';
  }

  return false;
}

export function toAppError(error: unknown, fallbackCode = 'INTERNAL_ERROR'): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const appErr = new AppError(fallbackCode, error.message, {
      originalName: error.name,
    });
    if (error.stack) {
      appErr.stack = error.stack;
    }
    return appErr;
  }

  if (typeof error === 'string') {
    return new AppError(fallbackCode, error);
  }

  return new AppError(fallbackCode, 'An unknown error occurred', {
    rawError: error,
  });
}
