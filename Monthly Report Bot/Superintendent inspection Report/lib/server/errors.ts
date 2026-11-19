/** An error with an HTTP status and a message that is safe to show. */
export class AppError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
