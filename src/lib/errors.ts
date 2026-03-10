export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class NotFoundError extends ApiError {
  constructor(code: string, message: string) {
    super(code, message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends ApiError {
  constructor(code: string, message: string) {
    super(code, message, 409);
    this.name = "ConflictError";
  }
}

export class BadRequestError extends ApiError {
  constructor(
    code: string = "INVALID_REQUEST",
    message: string = "Invalid request.",
    details?: unknown,
  ) {
    super(code, message, 400, details);
    this.name = "BadRequestError";
  }
}

export class ForbiddenError extends ApiError {
  constructor(
    code: string = "FORBIDDEN",
    message: string = "Access denied.",
  ) {
    super(code, message, 403);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends ApiError {
  constructor(
    code: string = "UNAUTHORIZED",
    message: string = "Authentication required.",
  ) {
    super(code, message, 401);
    this.name = "UnauthorizedError";
  }
}
