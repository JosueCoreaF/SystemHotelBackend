import type { NextFunction, Request, Response } from 'express';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const asyncHandler = (
  handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>,
) => (request: Request, response: Response, next: NextFunction) => {
  void handler(request, response, next).catch(next);
};