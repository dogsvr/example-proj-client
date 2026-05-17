/**
 * Rolling (ts, x, y) buffer for delayed-render interpolation. sample() lerps
 * between the two snapshots straddling renderTime, holding at the nearest
 * endpoint when out of range — never extrapolates.
 */

export interface Sample { x: number; y: number; }

interface Snapshot { ts: number; x: number; y: number; }

export class SnapshotBuffer {
    private readonly capacity: number;
    private readonly buf: Snapshot[] = [];

    constructor(capacity: number = 8) {
        this.capacity = Math.max(2, capacity);
    }

    /** Reset and seed with one point — call on entity creation. */
    seed(ts: number, x: number, y: number): void {
        this.buf.length = 0;
        this.buf.push({ ts, x, y });
    }

    /** Push a snapshot. A move > jumpDistSq is treated as teleport: clear
     *  history and re-seed so sample() doesn't draw across the map. */
    push(ts: number, x: number, y: number, jumpDistSq: number): void {
        const last = this.buf.length > 0 ? this.buf[this.buf.length - 1] : undefined;
        if (last) {
            const dx = x - last.x, dy = y - last.y;
            if (dx * dx + dy * dy > jumpDistSq) {
                this.buf.length = 0;
                this.buf.push({ ts, x, y });
                return;
            }
        }
        this.buf.push({ ts, x, y });
        if (this.buf.length > this.capacity) this.buf.shift();
    }

    sample(renderTime: number): Sample {
        const n = this.buf.length;
        if (n === 0) return { x: 0, y: 0 };
        if (n === 1 || renderTime <= this.buf[0].ts) {
            return { x: this.buf[0].x, y: this.buf[0].y };
        }
        const newest = this.buf[n - 1];
        if (renderTime >= newest.ts) return { x: newest.x, y: newest.y };

        // Scan from newest back — typical query is near the tail.
        for (let i = n - 1; i > 0; i--) {
            const right = this.buf[i];
            const left = this.buf[i - 1];
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
