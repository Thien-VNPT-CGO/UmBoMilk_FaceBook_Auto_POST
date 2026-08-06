export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Không được phép truy cập') {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Không có quyền thực hiện hành động này') {
    super(message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Không tìm thấy tài nguyên') {
    super(message, 404);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Yêu cầu không hợp lệ') {
    super(message, 400);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Tài nguyên đã tồn tại hoặc có xung đột') {
    super(message, 409);
  }
}