import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import RoundRectangle from 'phaser4-rex-plugins/plugins/roundrectangle.js';
import { Palette, Radius, Spacing, FontSize, HexText, textStyle } from '../theme';

/**
 * Shared top HUD for battle scenes. Which widgets appear is controlled by
 * the caller — lockstep keeps fps + status, state-sync uses kills + invuln.
 * The HUD is a single rexUI horizontal Sizer centered over a white card.
 */
export interface BattleHud {
    fps?: Phaser.GameObjects.Text;
    status?: Phaser.GameObjects.Text;
    kills?: Phaser.GameObjects.Text;
    deaths?: Phaser.GameObjects.Text;
    invuln?: Phaser.GameObjects.Text;
    interactives: Phaser.GameObjects.GameObject[];
    relayout(): void;
    height(): number;
}

export type HudWidgets = {
    fps?: boolean;
    status?: boolean;
    kills?: boolean;
    deaths?: boolean;
    invuln?: boolean;
};

interface RexScene extends Phaser.Scene { rexUI: UIPlugin; }

export function createBattleHud(
    scene: RexScene,
    onBack: () => void,
    widgets: HudWidgets = { fps: true, status: true },
): BattleHud {
    const hud: BattleHud = { interactives: [], relayout: () => {}, height: () => 0 };

    const captionStyle = () => textStyle({ size: FontSize.caption, color: HexText.primary, weight: 'bold' });
    const captionStyleRegular = () => textStyle({ size: FontSize.caption, color: HexText.primary });

    if (widgets.fps) hud.fps = scene.add.text(0, 0, 'FPS --', captionStyle());
    if (widgets.status) hud.status = scene.add.text(0, 0, 'Connecting…', captionStyleRegular());
    if (widgets.kills) hud.kills = scene.add.text(0, 0, 'Score 0', captionStyle());
    if (widgets.deaths) hud.deaths = scene.add.text(0, 0, 'Outs 0', captionStyle());
    if (widgets.invuln) hud.invuln = scene.add.text(0, 0, 'Invuln --', captionStyleRegular());

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

    const sizer = scene.rexUI.add.sizer({
        orientation: 'horizontal',
        space: { left: Spacing.md, right: Spacing.md, top: Spacing.sm, bottom: Spacing.sm, item: Spacing.md },
    }).addBackground(hudBg);

    // Order: fps → status → kills → deaths → invuln → Back. addSpace() between
    // items pushes Back to the right; each text gets addSpace after itself so
    // the widgets fan out evenly rather than crowd on the left.
    const leftWidgets: Phaser.GameObjects.Text[] = [];
    if (hud.fps) leftWidgets.push(hud.fps);
    if (hud.status) leftWidgets.push(hud.status);
    if (hud.kills) leftWidgets.push(hud.kills);
    if (hud.deaths) leftWidgets.push(hud.deaths);
    if (hud.invuln) leftWidgets.push(hud.invuln);

    for (let i = 0; i < leftWidgets.length; i++) {
        sizer.add(leftWidgets[i], { align: 'center' });
        sizer.addSpace();
    }
    if (leftWidgets.length === 0) sizer.addSpace(); // keep Back right-aligned even with no text
    sizer.add(backBtn, { align: 'center' });

    const relayout = () => {
        const { width } = scene.scale;
        const hudWidth = Math.min(width - Spacing.lg * 2, 500);
        sizer.setMinSize(hudWidth, 0);
        sizer.layout();
        sizer.setPosition(width / 2, Spacing.lg + sizer.height / 2);
    };
    relayout();

    // Pin every HUD GameObject to screen space. Battle scenes call
    // cameras.main.startFollow(player) which scrolls the world; without
    // scrollFactor=0 the HUD (positioned in world coords at the top) drifts
    // off-screen as soon as the camera moves. Phaser's Container.setScrollFactor
    // doesn't recurse into non-Container children by default, and rexUI's
    // Sizer doesn't override it, so we set it on each GameObject explicitly.
    const hudGOs: Phaser.GameObjects.GameObject[] = [hudBg, backBg, backText, backBtn];
    if (hud.fps) hudGOs.push(hud.fps);
    if (hud.status) hudGOs.push(hud.status);
    if (hud.kills) hudGOs.push(hud.kills);
    if (hud.deaths) hudGOs.push(hud.deaths);
    if (hud.invuln) hudGOs.push(hud.invuln);
    for (const go of hudGOs) (go as any).setScrollFactor?.(0);

    hud.interactives = [backBtn, backBg, backText];
    hud.relayout = relayout;
    hud.height = () => sizer.height;
    return hud;
}
