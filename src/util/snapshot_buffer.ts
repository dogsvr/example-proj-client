/**
 * Rolling (ts, x, y) buffer for delayed-render interpolation. sample() lerps
 * between the two snapshots straddling renderTime, holding at the nearest
 * endpoint when out of range — never extrapolates.
 */

export interface Sample { x: number; y: number; }

interface Snapshot { ts: number; x: number; y: number; }

export class SnapshotBuffer {
    private readonly capacity: number;
    private readonly buf: Snapshot[];
    private head = 0;   // next write
    private size = 0;   // valid entries

    constructor(capacity: number = 8) {
        this.capacity = Math.max(2, capacity);
        this.buf = new Array(this.capacity);
        for (let i = 0; i < this.capacity; i++) {
            this.buf[i] = { ts: 0, x: 0, y: 0 };
        }
    }

    /** Reset to a single point. */
    seed(ts: number, x: number, y: number): void {
        const slot = this.buf[0];
        slot.ts = ts; slot.x = x; slot.y = y;
        this.head = 1 % this.capacity;
        this.size = 1;
    }

    /** Push a snapshot. Move > jumpDistSq is a teleport: history reset (no lerp across map). */
    push(ts: number, x: number, y: number, jumpDistSq: number): void {
        if (this.size > 0) {
            const lastIdx = (this.head - 1 + this.capacity) % this.capacity;
            const last = this.buf[lastIdx];
            const dx = x - last.x, dy = y - last.y;
            if (dx * dx + dy * dy > jumpDistSq) {
                this.seed(ts, x, y);
                return;
            }
        }
        const slot = this.buf[this.head];
        slot.ts = ts; slot.x = x; slot.y = y;
        this.head = (this.head + 1) % this.capacity;
        if (this.size < this.capacity) this.size++;
    }

    sample(renderTime: number): Sample {
        if (this.size === 0) return { x: 0, y: 0 };

        const oldestIdx = (this.head - this.size + this.capacity) % this.capacity;
        const oldest = this.buf[oldestIdx];
        if (this.size === 1 || renderTime <= oldest.ts) {
            return { x: oldest.x, y: oldest.y };
        }

        const newestIdx = (this.head - 1 + this.capacity) % this.capacity;
        const newest = this.buf[newestIdx];
        if (renderTime >= newest.ts) return { x: newest.x, y: newest.y };

        // Scan from newest back — typical query is near the tail.
        for (let i = this.size - 1; i > 0; i--) {
            const right = this.buf[(oldestIdx + i) % this.capacity];
            const left = this.buf[(oldestIdx + i - 1) % this.capacity];
            if (left.ts <= renderTime && renderTime <= right.ts) {
                const span = right.ts - left.ts;
                const t = span > 0 ? (renderTime - left.ts) / span : 0;
                return {
                    x: left.x + (right.x - left.x) * t,
                    y: left.y + (right.y - left.y) * t,
                };
            }
        }
        return { x: newest.x, y: newest.y };
    }
}
