export class WompiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "[WompiError]";
  }
}
