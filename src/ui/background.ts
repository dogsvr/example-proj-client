import Phaser from 'phaser';

/**
 * Paint a vertical gradient across the entire camera viewport and attach it to
 * the scene's resize lifecycle.
 *
 * Phaser 4 doesn't expose a native "gradient fill rectangle" geometry, so we
 * draw a stack of 1px-tall slabs with `Graphics.fillStyle()` alpha-interpolated
 * between the two end colors. This is fast enough for static backgrounds
 * (drawn once per resize) and avoids the overhead of a WebGL filter or a
 * baked texture asset.
 *
 * The returned Graphics is depth-sorted to the very back (`setDepth(-1000)`)
 * so every normal UI element sits on top without needing its own depth tweak.
 *
 * Also scatters ~20 translucent floating shapes over the gradient and animates
 * them with `tweens.add({ yoyo, loop: -1 })`. The shapes are drawn as geometric
 * objects (no textures needed) to keep the first-paint asset cost at zero.
 */
export function paintGradientBackground(
    scene: Phaser.Scene,
    topColor: number,
    bottomColor: number,
): { gradient: Phaser.GameObjects.Graphics; decorations: Phaser.GameObjects.Graphics[] } {
    const gradient = scene.add.graphics();
    gradient.setDepth(-1000);
    gradient.setScrollFactor(0);

    const decorations: Phaser.GameObjects.Graphics[] = [];
    // Pre-spawn a handful of drifting shapes. They are pure Graphics (no
    // textures) so there's no asset loading cost even on first paint.
    for (let i = 0; i < 18; i++) {
        const deco = scene.add.graphics();
        deco.setDepth(-999);
        deco.setScrollFactor(0);
        decorations.push(deco);
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
        // Slab-based gradient: ~40 steps is indistinguishable from continuous
        // but keeps draw-call count predictable.
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

        // Redistribute decorations across the new viewport; kill existing
        // tweens on each to avoid stacking after repeated resizes.
        decorations.forEach((deco, idx) => {
            scene.tweens.killTweensOf(deco);
            deco.clear();
            const cx = (width * ((idx * 37) % 100)) / 100;
            const cy = (height * ((idx * 53) % 100)) / 100;
            const radius = 20 + ((idx * 7) % 30);
            const shade = idx % 3 === 0 ? 0xffffff : (idx % 3 === 1 ? topColor : bottomColor);
            deco.fillStyle(shade, 0.15);
            if (idx % 2 === 0) {
                deco.fillCircle(cx, cy, radius);
            } else {
                // diamond
                deco.beginPath();
                deco.moveTo(cx, cy - radius);
                deco.lineTo(cx + radius, cy);
                deco.lineTo(cx, cy + radius);
                deco.lineTo(cx - radius, cy);
                deco.closePath();
                deco.fillPath();
            }
            deco.setPosition(0, 0);
            scene.tweens.add({
                targets: deco,
                y: { from: 0, to: (idx % 2 === 0 ? -1 : 1) * 20 },
                duration: 4000 + ((idx * 311) % 3000),
                yoyo: true,
                repeat: -1,
                ease: 'Sine.easeInOut',
            });
        });
    };

    redraw();
    const onResize = () => redraw();
    scene.scale.on(Phaser.Scale.Events.RESIZE, onResize);
    // Important: clean up listener when the scene shuts down, otherwise each
    // resize fires N times after re-entering the scene.
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        scene.scale.off(Phaser.Scale.Events.RESIZE, onResize);
        scene.tweens.killTweensOf(decorations);
    });

    return { gradient, decorations };
}
