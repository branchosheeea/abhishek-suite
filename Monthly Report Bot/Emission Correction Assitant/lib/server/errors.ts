// Errors the API turns into safe client messages. Anything else becomes a generic 500 with details logged
// server-side only (no stack traces or connection details reach the browser).

export class AppError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class NotFound extends AppError {
  constructor(what = "Not found") {
    super(404, what)
  }
}

export class BadRequest extends AppError {
  constructor(message: string) {
    super(400, message)
  }
}

export class Conflict extends AppError {
  constructor(message: string) {
    super(409, message)
  }
}

export class PayloadTooLarge extends AppError {
  constructor(message = "The upload is too large.") {
    super(413, message)
  }
}

/** A registered source no longer matches its SHA-256. Never "fixed": the run stops and the event is audited. */
export class IntegrityError extends AppError {
  constructor(message: string) {
    super(409, message)
  }
}

export class StorageNotConfigured extends AppError {
  constructor() {
    super(503, "Storage is not configured. Set EMISSIONS_MONGODB_URI in .env.local (see .env.example) and restart.")
  }
}
