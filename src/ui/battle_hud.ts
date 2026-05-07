import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import RoundRectangle from 'phaser4-rex-plugins/plugins/roundrectangle.js';
import { Palette, Radius, Spacing, FontSize, HexText, textStyle } from '../theme';

/**
 * Shared top HUD for both battle scenes: FPS text, status text, Back button,
 * opaque white card background. Keeps WCAG AAA contrast via solid colors only.
 */
export interface BattleHud {
    fps: Phaser.GameObjects.Text;
    status: Phaser.GameObjects.Text;
    interactives: Phaser.GameObjects.GameObject[];
    relayout(): void;
    height(): number;
}

interface RexScene extends Phaser.Scene { rexUI: UIPlugin; }

export function createBattleHud(scene: RexScene, onBack: () => void): BattleHud {
    const fps = scene.add.text(0, 0, 'FPS --',
        textStyle({ size: FontSize.caption, color: HexText.primary, weight: 'bold' }));
    const status = scene.add.text(0, 0, 'Connecting…',
        textStyle({ size: FontSize.caption, color: HexText.primary }));

    const backBg = new RoundRectangle(scene, 0, 0, 2, 2, Radius.btn, Palette.textPrimary);
    scene.add.existing(backBg);
    const backText = scene.add.text(0, 0, '← Back',
        textStyle({ size: FontSize.caption, color: HexText.white, weight: 'bold' }));
    // 88×44 — UI Design Rules require ≥44×44 touch hit-zones.
    const backBtn = scene.rexUI.add.label({
        width: 88, height: 44, background: backBg, text: backText,
        align: 'center', space: { left: Spacing.md, right: Spacing.md },
    }).setInteractive({ useHandCursor: true });
    backBtn.on('pointerdown', onBack);

    // setDepth(-1) keeps the card under text children — rexUI's addBackground
    // only handles layout, not z-order.
    const hudBg = new RoundRectangle(scene, 0, 0, 2, 2, Radius.btn, Palette.cardBg, 1);
    hudBg.setStrokeStyle(1.5, Palette.cardStroke, 1);
    hudBg.setDepth(-1);
    scene.add.existing(hudBg);

    const hud = scene.rexUI.add.sizer({
        orientation: 'horizontal',
        space: { left: Spacing.md, right: Spacing.md, top: Spacing.sm, bottom: Spacing.sm, item: Spacing.md },
    })
        .addBackground(hudBg)
        .add(fps, { align: 'center' })
        .addSpace()
        .add(status, { align: 'center' })
        .addSpace()
        .add(backBtn, { align: 'center' });

    const relayout = () => {
        const { width } = scene.scale;
        const hudWidth = Math.min(width - Spacing.lg * 2, 500);
        hud.setMinSize(hudWidth, 0);
        hud.layout();
        hud.setPosition(width / 2, Spacing.lg + hud.height / 2);
    };
    relayout();

    return {
        fps, status,
        interactives: [backBtn, backBg, backText],
        relayout,
        height: () => hud.height,
    };
}
