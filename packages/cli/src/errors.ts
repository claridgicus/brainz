/** Error whose message is shown to the user (no stack); always exits 1. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}
