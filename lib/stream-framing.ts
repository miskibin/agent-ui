/**
 * Incremental LF framing without repeatedly concatenating and splitting the
 * whole unfinished record. A very large JSON/SSE line therefore costs linear
 * work and the fragments are joined exactly once, when its newline arrives.
 */
export class LineBuffer {
  private fragments: string[] = []
  private pendingLength = 0

  constructor(private readonly maxRecordLength = 64 * 1024 * 1024) {}

  private assertWithinLimit(length: number) {
    if (length > this.maxRecordLength) {
      throw new Error(
        `Stream record exceeded the ${this.maxRecordLength}-character limit`,
      )
    }
  }

  push(chunk: string): string[] {
    if (!chunk) return []
    const pieces = chunk.split("\n")
    if (pieces.length === 1) {
      this.pendingLength += chunk.length
      this.assertWithinLimit(this.pendingLength)
      this.fragments.push(chunk)
      return []
    }

    this.assertWithinLimit(this.pendingLength + pieces[0].length)
    for (const piece of pieces.slice(1, -1)) {
      this.assertWithinLimit(piece.length)
    }
    const lines = [
      this.fragments.join("") + pieces[0],
      ...pieces.slice(1, -1),
    ]
    const tail = pieces.at(-1) ?? ""
    this.assertWithinLimit(tail.length)
    this.fragments = tail ? [tail] : []
    this.pendingLength = tail.length
    return lines
  }

  finish(): string | null {
    if (this.fragments.length === 0) return null
    const line = this.fragments.join("")
    this.fragments = []
    this.pendingLength = 0
    return line
  }
}
