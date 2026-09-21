/**
 * Per-session FIFO mailbox (architecture.md §6).
 *
 * Guarantees at most one active task per key; queued tasks start in FIFO
 * order. Tasks are drain callbacks registered by the broker.
 */
export declare class Mailbox {
    private queue;
    private active;
    get depth(): number;
    get isActive(): boolean;
    /** Enqueue a task. It runs when the mailbox is otherwise idle. */
    push(task: () => Promise<void>): void;
    private drain;
    /** Resolve when queue and active task are both empty. For tests/shutdown. */
    idle(): Promise<void>;
}
/** One mailbox per session key. */
export declare class MailboxRegistry {
    private readonly mailboxes;
    for(key: string): Mailbox;
    allIdle(): Promise<void>;
}
