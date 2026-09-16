export class LocalTaskQueue {
  constructor({ concurrency = 1 } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.running = 0;
    this.pending = [];
    this.accepting = true;
    this.idleWaiters = [];
  }

  add(task) {
    if (!this.accepting) return Promise.reject(new Error("queue_closed"));
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this.drain();
    });
  }

  setConcurrency(concurrency) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.drain();
  }

  stats() {
    return {
      concurrency: this.concurrency,
      running: this.running,
      pending: this.pending.length,
      accepting: this.accepting,
    };
  }

  onIdle() {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  close() {
    this.accepting = false;
    this.notifyIdle();
    return this.onIdle();
  }

  notifyIdle() {
    if (this.running !== 0 || this.pending.length !== 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  drain() {
    while (this.running < this.concurrency && this.pending.length) {
      const item = this.pending.shift();
      this.running += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running -= 1;
          this.drain();
          this.notifyIdle();
        });
    }
    this.notifyIdle();
  }
}
