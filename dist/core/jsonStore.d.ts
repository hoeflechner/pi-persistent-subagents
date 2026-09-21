/**
 * Small durable JSON store: read whole file, mutate in memory under an
 * async mutex, write via temp file + atomic rename (architecture.md §6).
 *
 * MVP scale is a handful of records per user, so a whole-file store is
 * acceptable; the interface keeps a SQLite swap open.
 */
export declare class JsonStore<T extends object> {
    private readonly filePath;
    private queue;
    constructor(filePath: string);
    get path(): string;
    /**
     * Run `mutator` against the current state (or `initial()` when absent),
     * persist atomically when it returns a value other than `undefined`.
     * Serializes all operations for this file.
     */
    update(mutator: (state: T) => void | Promise<void>): Promise<void>;
    /** Read a snapshot copy without mutating. */
    read(): Promise<T>;
    private readOrInit;
    private writeAtomic;
    /** Overridable for tests via subclass or factory option below. */
    protected initial(): T;
}
export declare class CorruptStateError extends Error {
}
/** Factory variant that supplies the initial empty state. */
export declare function createJsonStore<T extends object>(filePath: string, initial: () => T): JsonStore<T>;
