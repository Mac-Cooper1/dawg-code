export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code machine-readable error code, sent as body.error
   */
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const notFound = () => new HttpError(404, "not_found");
export const badRequest = (code = "bad_request") => new HttpError(400, code);
