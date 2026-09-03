/** Stereo output ring with a source position per frame. */
export class OutputRing {
    left;
    right;
    position;
    capacity;
    readIndex = 0;
    writeIndex = 0;
    constructor(capacity) {
        this.capacity = capacity;
        this.left = new Float32Array(capacity);
        this.right = new Float32Array(capacity);
        this.position = new Float64Array(capacity);
    }
    get available() {
        return this.writeIndex - this.readIndex;
    }
    get free() {
        return this.capacity - this.available;
    }
    clear() {
        this.readIndex = 0;
        this.writeIndex = 0;
    }
    push(left, right, position) {
        const slot = this.writeIndex % this.capacity;
        this.left[slot] = left;
        this.right[slot] = right;
        this.position[slot] = position;
        this.writeIndex += 1;
    }
    /** Position of the frame `offset` ahead of the read cursor. */
    positionAt(offset) {
        return this.position[(this.readIndex + offset) % this.capacity] ?? NaN;
    }
    /** Copies `frames` frames into the outputs starting at `offset`, then advances. */
    pop(left, right, offset, frames) {
        for (let i = 0; i < frames; i += 1) {
            const slot = (this.readIndex + i) % this.capacity;
            left[offset + i] = this.left[slot] ?? 0;
            right[offset + i] = this.right[slot] ?? 0;
        }
        this.readIndex += frames;
    }
}
