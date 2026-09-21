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
export class JsonStore {
    filePath;
    queue = Promise.resolve();
    constructor(filePath) {
        this.filePath = filePath;
    }
    get path() {
        return this.filePath;
    }
    /**
     * Run `mutator` against the current state (or `initial()` when absent),
     * persist atomically when it returns a value other than `undefined`.
     * Serializes all operations for this file.
     */
    async update(mutator) {
        const run = async () => {
            const state = await this.readOrInit();
            await mutator(state);
            await this.writeAtomic(state);
        };
        const next = this.queue.then(run, run);
        this.queue = next.catch(() => undefined);
        return next;
    }
    /** Read a snapshot copy without mutating. */
    async read() {
        const run = async () => ({ ...(await this.readOrInit()) });
        const next = this.queue.then(run, run);
        this.queue = next.catch(() => undefined);
        return next;
    }
    async readOrInit() {
        try {
            const raw = await fsp.readFile(this.filePath, "utf8");
            return JSON.parse(raw);
        }
        catch (err) {
            if (isNotFound(err))
                return this.initial();
            throw new CorruptStateError(`Refusing to overwrite unreadable state file ${this.filePath}: ${err.message}`);
        }
    }
    async writeAtomic(state) {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.${randomUUID()}.tmp`;
        const payload = `${JSON.stringify(state, null, 2)}\n`;
        await fsp.writeFile(tmp, payload, "utf8");
        await fsp.rename(tmp, this.filePath);
    }
    /** Overridable for tests via subclass or factory option below. */
    initial() {
        return {};
    }
}
export class CorruptStateError extends Error {
}
function isNotFound(err) {
    return (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT");
}
/** Factory variant that supplies the initial empty state. */
export function createJsonStore(filePath, initial) {
    return new InitializedStore(filePath, initial);
}
class InitializedStore extends JsonStore {
    init;
    constructor(filePath, init) {
        super(filePath);
        this.init = init;
    }
    initial() {
        return this.init();
    }
}
//# sourceMappingURL=jsonStore.js.map