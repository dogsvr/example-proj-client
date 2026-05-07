import Phaser from 'phaser';

/**
 * Scene background: interpolated-slab vertical gradient + drifting shapes.
 * Tweens persist across resizes; redraw only repositions the graphics.
 */
export function paintGradientBackground(
    scene: Phaser.Scene,
    topColor: number,
    bottomColor: number,
): { gradient: Phaser.GameObjects.Graphics; decorations: Phaser.GameObjects.Graphics[] } {
    const gradient = scene.add.graphics();
    gradient.setDepth(-1000);
    gradient.setScrollFactor(0);

    const N = 18;
    const decorations: Phaser.GameObjects.Graphics[] = [];
    const tweens: Phaser.Tweens.Tween[] = [];
    for (let i = 0; i < N; i++) {
        const deco = scene.add.graphics();
        deco.setDepth(-999);
        deco.setScrollFactor(0);
        decorations.push(deco);
        // Yoyo deco.y ±20 on top of the cx/cy baked into the drawing.
        tweens.push(scene.tweens.add({
            targets: deco,
            y: (i % 2 === 0 ? -1 : 1) * 20,
            duration: 4000 + ((i * 311) % 3000),
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
        }));
    }

    const redraw = () => {
        const { width, height } = scene.scale;
        const topR = (topColor >> 16) & 0xff;
        const topG = (topColor >> 8) & 0xff;
        const topB = topColor & 0xff;
        const botR = (bottomColor >> 16) & 0xff;
        const botG = (bottomColor >> 8) & 0xff;
        const botB = bottomColor & 0xff;

        gradient.clear();
        const steps = 40;
        for (let i = 0; i < steps; i++) {
            const t = i / (steps - 1);
            const r = Math.round(topR + (botR - topR) * t);
            const g = Math.round(topG + (botG - topG) * t);
            const b = Math.round(topB + (botB - topB) * t);
            gradient.fillStyle((r << 16) | (g << 8) | b, 1);
            const sliceY = Math.floor((i * height) / steps);
            const sliceH = Math.ceil(height / steps) + 1;
            gradient.fillRect(0, sliceY, width, sliceH);
        }

        // Reposition by redrawing (cx/cy baked into the shape); leave tweens alone.
        decorations.forEach((deco, idx) => {
            const cx = (width * ((idx * 37) % 100)) / 100;
            const cy = (height * ((idx * 53) % 100)) / 100;
            const radius = 20 + ((idx * 7) % 30);
            const shade = idx % 3 === 0 ? 0xffffff : (idx % 3 === 1 ? topColor : bottomColor);
            deco.clear();
            deco.fillStyle(shade, 0.15);
            if (idx % 2 === 0) {
                deco.fillCircle(cx, cy, radius);
            } else {
                deco.beginPath();
                deco.moveTo(cx, cy - radius);
                deco.lineTo(cx + radius, cy);
                deco.lineTo(cx, cy + radius);
                deco.lineTo(cx - radius, cy);
                deco.closePath();
                deco.fillPath();
            }
            deco.x = 0;
        });
    };

    redraw();

    // Debounce resize — drag can fire the event dozens of times/sec.
    let resizeTimer: Phaser.Time.TimerEvent | null = null;
    const onResize = () => {
        if (resizeTimer) resizeTimer.remove(false);
        resizeTimer = scene.time.delayedCall(50, redraw);
    };
    scene.scale.on(Phaser.Scale.Events.RESIZE, onResize);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        scene.scale.off(Phaser.Scale.Events.RESIZE, onResize);
        if (resizeTimer) resizeTimer.remove(false);
        for (const t of tweens) t.stop();
    });

    return { gradient, decorations };
}
