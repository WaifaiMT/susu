export type AppErrorCode = "validation" | "not_found" | "forbidden" | "conflict" | "unauthenticated";

/** An expected failure whose message is safe to show to the user. */
export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
