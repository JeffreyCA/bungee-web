/** Stereo output ring with a source position per frame. */
export class OutputRing {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readonly position: Float64Array;
  readonly capacity: number;
  private readIndex = 0;
  private writeIndex = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.left = new Float32Array(capacity);
    this.right = new Float32Array(capacity);
    this.position = new Float64Array(capacity);
  }

  get available(): number {
    return this.writeIndex - this.readIndex;
  }

  get free(): number {
    return this.capacity - this.available;
  }

  clear(): void {
    this.readIndex = 0;
    this.writeIndex = 0;
  }

  push(left: number, right: number, position: number): void {
    const slot = this.writeIndex % this.capacity;
    this.left[slot] = left;
    this.right[slot] = right;
    this.position[slot] = position;
    this.writeIndex += 1;
  }

  /** Position of the frame `offset` ahead of the read cursor. */
  positionAt(offset: number): number {
    return this.position[(this.readIndex + offset) % this.capacity] ?? NaN;
  }

  /** Copies `frames` frames into the outputs starting at `offset`, then advances. */
  pop(left: Float32Array, right: Float32Array, offset: number, frames: number): void {
    for (let i = 0; i < frames; i += 1) {
      const slot = (this.readIndex + i) % this.capacity;
      left[offset + i] = this.left[slot] ?? 0;
      right[offset + i] = this.right[slot] ?? 0;
    }
    this.readIndex += frames;
  }
}
