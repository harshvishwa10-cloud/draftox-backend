export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(403, 'FORBIDDEN', message);
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string) {
    return new ApiError(409, 'CONFLICT', message);
  }

  static unprocessable(message: string, details?: unknown) {
    return new ApiError(422, 'VALIDATION_ERROR', message, details);
  }

  static tooMany(message = 'Too many requests, please try again later.') {
    return new ApiError(429, 'RATE_LIMITED', message);
  }

  static internal(message = 'An unexpected error occurred') {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }

  static serviceUnavailable(message: string) {
    return new ApiError(503, 'SERVICE_UNAVAILABLE', message);
  }

  /** Ordering is intentionally paused (server-side `STORE_ORDERS_PAUSED`). */
  static ordersDisabled(message: string) {
    return new ApiError(503, 'ORDERS_DISABLED', message);
  }
}
