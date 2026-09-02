/**
 * Minimal concurrency gate for a code path that has no BullMQ queue of
 * its own to lean on (currently just POST /:id/edit - see edit-asset.ts).
 * Queues excess callers FIFO rather than rejecting them, matching an
 * already-synchronous "wait for the real answer" endpoint contract - the
 * caller was always going to wait for a slow provider call anyway, this
 * just bounds how many of those calls are in flight at once instead of
 * firing every simultaneous request straight at the provider uncapped.
 */
export class Semaphore {
  private counter: number;
  private readonly waiting: Array<() => void> = [];

  constructor(max: number) {
    this.counter = max;
  }

  /** Runs fn once a slot is free, always releasing the slot afterward -
   *  success or failure - so a thrown error can never leak a permanently
   *  held slot. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.counter > 0) {
      this.counter -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next(); // hand the freed slot directly to the next waiter, counter stays put
    } else {
      this.counter += 1;
    }
  }
}
