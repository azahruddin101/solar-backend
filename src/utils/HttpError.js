export class HttpError extends Error {
  /** `code` is an optional machine-readable reason sent alongside the message. */
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const unauthorized = (message = 'Sign in to continue') => new HttpError(401, message);
export const forbidden = (message = 'You do not have access to this area') => new HttpError(403, message);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
export const conflict = (message) => new HttpError(409, message);
