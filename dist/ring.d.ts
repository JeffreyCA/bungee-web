/** Stereo output ring with a source position per frame. */
export declare class OutputRing {
    private readonly left;
    private readonly right;
    private readonly position;
    readonly capacity: number;
    private readIndex;
    private writeIndex;
    constructor(capacity: number);
    get available(): number;
    get free(): number;
    clear(): void;
    push(left: number, right: number, position: number): void;
    /** Position of the frame `offset` ahead of the read cursor. */
    positionAt(offset: number): number;
    /** Copies `frames` frames into the outputs starting at `offset`, then advances. */
    pop(left: Float32Array, right: Float32Array, offset: number, frames: number): void;
}
