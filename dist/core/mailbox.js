/**
 * Per-session FIFO mailbox (architecture.md §6).
 *
 * Guarantees at most one active task per key; queued tasks start in FIFO
 * order. Tasks are drain callbacks registered by the broker.
 */
export class Mailbox {
    queue = [];
    active = false;
    get depth() {
        return this.queue.length + (this.active ? 1 : 0);
    }
    get isActive() {
        return this.active;
    }
    /** Enqueue a task. It runs when the mailbox is otherwise idle. */
    push(task) {
        this.queue.push(task);
        this.drain();
    }
    drain() {
        if (this.active)
            return;
        const next = this.queue.shift();
        if (!next)
            return;
        this.active = true;
        void Promise.resolve()
            .then(next)
            .catch(() => {
            // Task errors must be handled by the broker; never reject here.
        })
            .finally(() => {
            this.active = false;
            this.drain();
        });
    }
    /** Resolve when queue and active task are both empty. For tests/shutdown. */
    async idle() {
        while (this.active || this.queue.length > 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
}
/** One mailbox per session key. */
export class MailboxRegistry {
    mailboxes = new Map();
    for(key) {
        let box = this.mailboxes.get(key);
        if (!box) {
            box = new Mailbox();
            this.mailboxes.set(key, box);
        }
        return box;
    }
    async allIdle() {
        await Promise.all([...this.mailboxes.values()].map((m) => m.idle()));
    }
}
//# sourceMappingURL=mailbox.js.map