/** Raised when no unlock secret or identity opens the data; never reveals which part failed. */
export class WrongKeyError extends Error {
  constructor(what = "data") {
    super(`could not decrypt ${what} with the provided key`);
    this.name = "WrongKeyError";
  }
}
