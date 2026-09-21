/**
 * Per-session FIFO mailbox (architecture.md §6).
 *
 * Guarantees at most one active task per key; queued tasks start in FIFO
 * order. Tasks are drain callbacks registered by the broker.
 */
export class Mailbox {
  private queue: Array<() => Promise<void>> = [];
  private active = false;

  get depth(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Enqueue a task. It runs when the mailbox is otherwise idle. */
  push(task: () => Promise<void>): void {
    this.queue.push(task);
    this.drain();
  }

  private drain(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
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
  async idle(): Promise<void> {
    while (this.active || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/** One mailbox per session key. */
export class MailboxRegistry {
  private readonly mailboxes = new Map<string, Mailbox>();

  for(key: string): Mailbox {
    let box = this.mailboxes.get(key);
    if (!box) {
      box = new Mailbox();
      this.mailboxes.set(key, box);
    }
    return box;
  }

  async allIdle(): Promise<void> {
    await Promise.all([...this.mailboxes.values()].map((m) => m.idle()));
  }
}
