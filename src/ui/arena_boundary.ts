import Phaser from 'phaser';
import { Palette } from '../theme';

/**
 * Subtle arena boundary for battle scenes. World-space, so camera follow
 * reveals the edge as the player approaches. Two stroke passes (soft
 * bleed + inner line) + four L-bracket corners anchor the arena without
 * shouting for attention. Self-cleans on scene SHUTDOWN.
 */
export function paintArenaBoundary(
    scene: Phaser.Scene,
    mapWidth: number,
    mapHeight: number,
): Phaser.GameObjects.Graphics {
    const g = scene.add.graphics();
    // Under players/bullets, above background gradient.
    g.setDepth(-10);

    // Soft bleed — faint rim widening the edge.
    g.lineStyle(4, Palette.textSecondary, 0.20);
    g.strokeRect(0, 0, mapWidth, mapHeight);

    // Crisp inner stroke. Neutral grey reads as "structure", not UI accent.
    g.lineStyle(1.5, Palette.textSecondary, 0.70);
    g.strokeRect(0, 0, mapWidth, mapHeight);

    // Corner L-brackets.
    const armLen = Math.min(mapWidth, mapHeight) * 0.05;
    const armThick = 2.5;
    g.lineStyle(armThick, 0xFFFFFF, 0.7);

    const drawCorner = (cx: number, cy: number, dx: number, dy: number) => {
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + armLen * dx, cy);
        g.strokePath();
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx, cy + armLen * dy);
        g.strokePath();
    };
    drawCorner(0, 0, 1, 1);
    drawCorner(mapWidth, 0, -1, 1);
    drawCorner(0, mapHeight, 1, -1);
    drawCorner(mapWidth, mapHeight, -1, -1);

    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        try { g.destroy(); } catch {}
    });

    return g;
}

