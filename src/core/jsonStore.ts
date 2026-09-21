import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Small durable JSON store: read whole file, mutate in memory under an
 * async mutex, write via temp file + atomic rename (architecture.md §6).
 *
 * MVP scale is a handful of records per user, so a whole-file store is
 * acceptable; the interface keeps a SQLite swap open.
 */
export class JsonStore<T extends object> {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Run `mutator` against the current state (or `initial()` when absent),
   * persist atomically when it returns a value other than `undefined`.
   * Serializes all operations for this file.
   */
  async update(mutator: (state: T) => void | Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      const state = await this.readOrInit();
      await mutator(state);
      await this.writeAtomic(state);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next as Promise<void>;
  }

  /** Read a snapshot copy without mutating. */
  async read(): Promise<T> {
    const run = async (): Promise<T> => ({ ...(await this.readOrInit()) });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next as Promise<T>;
  }

  private async readOrInit(): Promise<T> {
    try {
      const raw = await fsp.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (err) {
      if (isNotFound(err)) return this.initial();
      throw new CorruptStateError(
        `Refusing to overwrite unreadable state file ${this.filePath}: ${(err as Error).message}`,
      );
    }
  }

  private async writeAtomic(state: T): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    await fsp.writeFile(tmp, payload, "utf8");
    await fsp.rename(tmp, this.filePath);
  }

  /** Overridable for tests via subclass or factory option below. */
  protected initial(): T {
    return {} as T;
  }
}

export class CorruptStateError extends Error {}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

/** Factory variant that supplies the initial empty state. */
export function createJsonStore<T extends object>(
  filePath: string,
  initial: () => T,
): JsonStore<T> {
  return new InitializedStore(filePath, initial);
}

class InitializedStore<T extends object> extends JsonStore<T> {
  constructor(
    filePath: string,
    private readonly init: () => T,
  ) {
    super(filePath);
  }

  protected override initial(): T {
    return this.init();
  }
}
