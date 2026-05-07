import Phaser from 'phaser';
import { Palette, Radius, HexText, textStyle } from '../theme';

/**
 * Progress-bar overlay that doesn't depend on rexUI — used by the *first*
 * scene (PreloadScene) while rexUI may still be downloading.
 */
export class ProgressOverlay {
    private scene: Phaser.Scene;
    private root: Phaser.GameObjects.Container;
    private backdrop: Phaser.GameObjects.Rectangle;
    private track: Phaser.GameObjects.Graphics;
    private label: Phaser.GameObjects.Text;
    private current = 0;

    constructor(scene: Phaser.Scene) {
        this.scene = scene;
        this.root = scene.add.container(0, 0).setDepth(10000).setScrollFactor(0);
        this.root.setVisible(false);

        this.backdrop = scene.add
            .rectangle(0, 0, scene.scale.width, scene.scale.height, Palette.overlay, 0.55)
            .setOrigin(0, 0);
        this.track = scene.add.graphics();
        this.label = scene.add
            .text(0, 0, 'Loading 0%',
                textStyle({ size: 16, color: HexText.white, weight: 'semibold' }))
            .setOrigin(0.5, 0.5);

        this.root.add([this.backdrop, this.track, this.label]);
        this.layout();

        const onResize = () => this.layout();
        scene.scale.on(Phaser.Scale.Events.RESIZE, onResize);
        scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            scene.scale.off(Phaser.Scale.Events.RESIZE, onResize);
        });
    }

    show(message = 'Loading') {
        this.current = 0;
        this.label.setText(`${message} 0%`);
        this.draw();
        this.root.setVisible(true);
    }

    setProgress(v: number, message = 'Loading') {
        this.current = Math.max(0, Math.min(1, v));
        this.label.setText(`${message} ${Math.round(this.current * 100)}%`);
        this.draw();
    }

    hide() {
        this.scene.tweens.add({
            targets: this.root,
            alpha: { from: 1, to: 0 },
            duration: 200,
            onComplete: () => {
                this.root.setVisible(false);
                this.root.setAlpha(1);
            },
        });
    }

    destroy() {
        this.root.destroy();
    }

    private layout() {
        const { width, height } = this.scene.scale;
        this.backdrop.setSize(width, height);
        this.label.setPosition(width / 2, height / 2 - 30);
        this.draw();
    }

    private draw() {
        const { width, height } = this.scene.scale;
        const barWidth = Math.min(width * 0.6, 280);
        const barHeight = 12;
        const x = (width - barWidth) / 2;
        const y = height / 2;
        this.track.clear();
        this.track.fillStyle(0xffffff, 0.25);
        this.track.fillRoundedRect(x, y, barWidth, barHeight, Radius.btn / 2);
        this.track.fillStyle(Palette.accent, 1);
        this.track.fillRoundedRect(x, y, barWidth * this.current, barHeight, Radius.btn / 2);
    }
}
