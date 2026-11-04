export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = 'error',
  ) {
    super(message);
  }
}
export const badRequest = (m: string, code = 'bad_request') => new HttpError(400, m, code);
export const unauthorized = (m = 'Unauthorized') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Forbidden') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');
