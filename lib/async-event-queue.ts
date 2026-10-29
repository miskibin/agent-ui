/** A single-consumer queue for subprocess output and asynchronous callbacks. */
export class AsyncEventQueue<T> {
  private items: T[] = []
  private wake?: () => void
  private ended = false

  push(value: T) {
    if (this.ended) return
    this.items.push(value)
    this.wake?.()
  }

  close() {
    this.ended = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const batch = this.items.splice(0)
      yield* batch
      if (this.ended && !this.items.length) return
      if (!this.items.length) await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }
}
