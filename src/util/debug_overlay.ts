import Phaser from 'phaser';
import { FontSize, HexText, Spacing, textStyle } from '../theme';

/**
 * Pinned dev metric overlay (bottom-left). Throttled to refreshIntervalMs
 * (default 300ms) so fast-changing values stay readable.
 */
export class DebugOverlay {
    private readonly scene: Phaser.Scene;
    private readonly text: Phaser.GameObjects.Text;
    private readonly bg: Phaser.GameObjects.Rectangle;
    private readonly entries: Map<string, string> = new Map();
    private readonly onResize: () => void;
    private readonly refreshIntervalMs: number;
    private dirty = false;
    private lastRenderAt = 0;

    constructor(scene: Phaser.Scene, refreshIntervalMs: number = 300) {
        this.scene = scene;
        this.refreshIntervalMs = refreshIntervalMs;

        this.bg = scene.add.rectangle(0, 0, 2, 2, 0x000000, 0.45)
            .setOrigin(0, 1)
            .setScrollFactor(0)
            .setDepth(900);

        this.text = scene.add.text(0, 0, '', textStyle({
            size: FontSize.caption,
            color: HexText.white,
        }))
            .setOrigin(0, 1)
            .setScrollFactor(0)
            .setDepth(901);

        this.onResize = () => this.relayout();
        scene.scale.on(Phaser.Scale.Events.RESIZE, this.onResize);
        scene.events.on(Phaser.Scenes.Events.UPDATE, this.tick, this);
        scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            try { scene.scale.off(Phaser.Scale.Events.RESIZE, this.onResize); } catch {}
            try { scene.events.off(Phaser.Scenes.Events.UPDATE, this.tick, this); } catch {}
            try { this.text.destroy(); } catch {}
            try { this.bg.destroy(); } catch {}
        });

        this.relayout();
    }

    set(key: string, value: string | number): void {
        const v = typeof value === 'number' ? value.toString() : value;
        if (this.entries.get(key) === v) return;
        this.entries.set(key, v);
        this.dirty = true;
    }

    private tick(time: number): void {
        if (!this.dirty) return;
        if (time - this.lastRenderAt < this.refreshIntervalMs) return;
        this.lastRenderAt = time;
        this.dirty = false;
        this.render();
    }

    private render(): void {
        const keys = Array.from(this.entries.keys()).sort();
        const lines = keys.map(k => `${k}: ${this.entries.get(k)}`);
        this.text.setText(lines);
        this.relayout();
    }

    private relayout(): void {
        const pad = Spacing.sm;
        const x = Spacing.md;
        const y = this.scene.scale.height - Spacing.md;
        this.text.setPosition(x + pad, y - pad);
        const w = this.text.width + pad * 2;
        const h = this.text.height + pad * 2;
        this.bg.setPosition(x, y).setSize(Math.max(w, 1), Math.max(h, 1));
    }
}
