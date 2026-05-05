import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import RoundRectangle from 'phaser4-rex-plugins/plugins/roundrectangle.js';
import { Palette, Radius, Spacing, FontSize, HexText, SceneBG, menuButtonWidth, textStyle } from '../theme';
import { paintGradientBackground } from '../ui/background';
import { showRankDialog } from '../ui/rank_dialog';
import { getLoggedInRole, onConnectionChange, queryRankList, registerBattleEndHandler, startBattle } from '../bootstrap';
import { getPreloadScene } from './preload_scene';

/**
 * Main menu scene. Layout is a vertical rexUI Sizer:
 *
 *   [role card]          <- top card: name / zoneId / score
 *   [menu buttons]       <- 3 big buttons: state battle / lockstep / rank
 *   [status]             <- bottom footer: connection dot + version
 *
 * All geometry is derived from the current `this.scale.width/height` and
 * re-laid-out on every resize event, so the menu stays centered when the
 * browser window (or device) changes size / orientation.
 */
export class MainScene extends Phaser.Scene {
    // rexUI plugin is injected via `scene.plugins.scene` mapping in boot.ts.
    rexUI!: UIPlugin;

    private root!: any;
    private roleNameText!: Phaser.GameObjects.Text;
    private roleZoneText!: Phaser.GameObjects.Text;
    private roleScoreText!: Phaser.GameObjects.Text;
    private connectionDot!: Phaser.GameObjects.Arc;

    constructor() {
        super({ key: 'main' });
    }

    create() {
        paintGradientBackground(this, SceneBG.main.top, SceneBG.main.bottom);

        this.root = this.buildRoot();
        this.relayout();

        registerBattleEndHandler((ntf) => this.onBattleEnd(ntf));

        // Wire the footer connection dot to real WebSocket state. The
        // subscription fires synchronously with the current state, so the
        // dot paints correctly on first enter even if login finished
        // before this scene was created.
        const unsubConn = onConnectionChange((connected) => {
            this.drawConnectionDot(connected);
        });

        this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);

        // scene.switch() puts main to SLEEP (not STOP) when entering battle;
        // when battle stops and calls scene.run('main'), main wakes up but
        // create() is NOT re-invoked, so the camera is still in whatever FX
        // state it was left in. Re-run fadeIn on every wake/resume so we
        // don't end up stuck on a white screen.
        const refade = () => {
            this.cameras.main.resetFX();
            this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);
        };
        this.events.on(Phaser.Scenes.Events.WAKE, refade);
        this.events.on(Phaser.Scenes.Events.RESUME, refade);

        const onResize = () => this.relayout();
        this.scale.on(Phaser.Scale.Events.RESIZE, onResize);
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.scale.off(Phaser.Scale.Events.RESIZE, onResize);
            this.events.off(Phaser.Scenes.Events.WAKE, refade);
            this.events.off(Phaser.Scenes.Events.RESUME, refade);
            unsubConn();
        });
    }

    // ---- layout ------------------------------------------------------------

    private buildRoot(): any {
        const role = getLoggedInRole() ?? this.registry.get('roleLocal') ?? {};
        const screenW = this.scale.width;
        const btnWidth = menuButtonWidth(screenW);

        const roleCard = this.buildRoleCard(role, btnWidth);
        const menu = this.buildMenu(btnWidth);
        const footer = this.buildFooter(btnWidth);

        const root = this.rexUI.add
            .sizer({
                orientation: 'vertical',
                space: { item: Spacing.lg },
            })
            .add(roleCard, { align: 'center', expand: false })
            .add(menu, { align: 'center', expand: false })
            .add(footer, { align: 'center', expand: false });

        return root;
    }

    private buildRoleCard(role: any, width: number): any {
        // Card background: RoundRectangle shape object. rexUI Sizer uses its
        // first "background" child as the pane, we add it explicitly with
        // `addBackground`.
        const bg = new RoundRectangle(this, 0, 0, width, 0, Radius.card, Palette.cardBg);
        bg.setStrokeStyle(1, Palette.cardStroke, 1);
        this.add.existing(bg);

        this.roleNameText = this.add.text(0, 0, `Name: ${role.name ?? '--'}`,
            textStyle({ size: FontSize.body, color: HexText.primary, weight: 'semibold' }));
        this.roleZoneText = this.add.text(0, 0, `Zone:   ${role.zoneId ?? '--'}`,
            textStyle({ size: FontSize.body, color: HexText.sceneSecondary }));
        this.roleScoreText = this.add.text(0, 0, `Score:  ${role.score ?? 0}`,
            textStyle({ size: FontSize.body, color: HexText.sceneSecondary }));

        const textColumn = this.rexUI.add
            .sizer({ orientation: 'vertical', space: { item: Spacing.xs } })
            .add(this.roleNameText, { align: 'left' })
            .add(this.roleZoneText, { align: 'left' })
            .add(this.roleScoreText, { align: 'left' });

        return this.rexUI.add
            .sizer({
                orientation: 'horizontal',
                space: {
                    left: Spacing.md,
                    right: Spacing.md,
                    top: Spacing.md,
                    bottom: Spacing.md,
                    item: Spacing.md,
                },
            })
            .addBackground(bg)
            .add(textColumn, { proportion: 1, align: 'left', expand: true });
    }

    private buildMenu(width: number): any {
        const buttons = this.rexUI.add.sizer({
            orientation: 'vertical',
            space: { item: Spacing.md },
        });

        const addBtn = (label: string, handler: () => void | Promise<void>, primary = true) => {
            const btn = this.makeButton(label, width, primary);
            btn.on('pointerdown', async () => {
                btn.setScale(0.98);
                try {
                    await handler();
                } finally {
                    btn.setScale(1);
                }
            });
            buttons.add(btn, { align: 'center' });
        };

        addBtn('Start Battle (state sync)', () => this.onStartBattle('state'));
        addBtn('Start Battle (lockstep)', () => this.onStartBattle('lockstep'));
        addBtn('Query Rank List', () => this.onQueryRank(), false);

        return buttons;
    }

    private makeButton(text: string, width: number, primary: boolean): any {
        const color = primary ? Palette.accent : Palette.cardBg;
        const bg = new RoundRectangle(this, 0, 0, 2, 2, Radius.btn, color);
        if (!primary) {
            bg.setStrokeStyle(1, Palette.accent, 1);
        }
        this.add.existing(bg);
        // Button label sits on a solid-colored RoundRectangle (accent or
        // white) — not on the gradient — so no shadow needed.
        const labelText = this.add.text(0, 0, text,
            textStyle({
                size: FontSize.body,
                color: primary ? HexText.white : '#3498DB',
                weight: 'semibold',
            }));
        const label = this.rexUI.add.label({
            width,
            height: 56,
            background: bg,
            text: labelText,
            align: 'center',
            space: { left: Spacing.md, right: Spacing.md, top: 0, bottom: 0 },
        });
        label.setInteractive({ useHandCursor: true });
        return label;
    }

    private buildFooter(width: number): any {
        // A Shape (Arc) is used instead of Graphics because rexUI Sizer
        // measures its children via `.width` / `.height`; Graphics has
        // neither until an explicit setSize(), and `setSize` isn't on
        // Graphics in Phaser 4. Using `scene.add.circle()` gives us a real
        // GameObject with proper bounds out of the box.
        this.connectionDot = this.add.circle(0, 0, 5, Palette.success);
        // Footer sits directly on the gradient background — use the deeper
        // sceneSecondary colour and a subtle shadow to keep the caption-
        // sized "v0.1.0" readable without ballooning the font size.
        const versionText = this.add.text(0, 0, 'v0.1.0',
            textStyle({
                size: FontSize.caption,
                color: HexText.sceneSecondary,
                shadow: true,
            }));
        return this.rexUI.add
            .sizer({
                orientation: 'horizontal',
                width,
                space: { item: Spacing.sm },
            })
            .add(this.connectionDot, { align: 'left' })
            .addSpace()
            .add(versionText, { align: 'right' });
    }

    private drawConnectionDot(connected: boolean) {
        this.connectionDot.setFillStyle(connected ? Palette.success : Palette.danger);
    }

    private relayout() {
        const { width, height } = this.scale;
        if (!this.root) return;
        this.root.setMinSize(0, 0);
        this.root.layout();

        // Landscape / short-height fallback (UI Design Rules §4). The vertical
        // stack (role card + 3 × 56 px menu + footer + gaps) wants about
        // 400 px of height to render without clipping. On short-height
        // viewports — e.g. iPhone SE rotated to landscape (~320 px usable
        // height), or desktop windows squashed tall-to-short — downscale the
        // whole root instead of letting it bleed out of the viewport. No
        // upscale: on tall viewports we'd rather the menu sit at its intrinsic
        // size in the middle than balloon to fill the space.
        const desiredH = 420;
        const margin = Spacing.md * 2;
        const scale = Math.min(1, (height - margin) / desiredH);
        this.root.setScale(scale);

        this.root.setPosition(width / 2, height / 2);
    }

    // ---- actions -----------------------------------------------------------

    private async onStartBattle(syncType: 'state' | 'lockstep') {
        try {
            const res = await startBattle(syncType);
            this.registry.set('startBattleRes', res);
        } catch (e: any) {
            this.showToast(`Start battle failed: ${e?.message ?? e}`, true);
            return;
        }

        const preload = getPreloadScene(this.game);
        const label = syncType === 'state' ? 'Loading battle…' : 'Loading battle…';
        try {
            if (syncType === 'state') {
                const mod = await preload.showProgressWhile(
                    label,
                    import('./state_sync_battle_scene'),
                );
                const key = 'state_sync_battle';
                if (!this.scene.get(key)) {
                    this.scene.add(key, mod.StateSyncBattleScene, false);
                }
                // Sleep main (keeping its display list + Sizer) and start
                // battle. Battle scene does its own fadeIn for the visual
                // transition; we must NOT fadeOut main's camera because that
                // leaves main hidden behind a white overlay after wake.
                this.scene.switch(key);
            } else {
                const mod = await preload.showProgressWhile(
                    label,
                    import('./lockstep_sync_battle_scene'),
                );
                const key = 'lockstep_sync_battle';
                if (!this.scene.get(key)) {
                    this.scene.add(key, mod.LockstepSyncBattleScene, false);
                }
                this.scene.switch(key);
            }
        } catch (e: any) {
            this.showToast(`Load battle failed: ${e?.message ?? e}`, true);
        }
    }

    private async onQueryRank() {
        try {
            const res = await queryRankList();
            const role = getLoggedInRole() ?? this.registry.get('roleLocal') ?? {};
            showRankDialog(this, res, role);
        } catch (e: any) {
            this.showToast(`Query rank failed: ${e?.message ?? e}`, true);
        }
    }

    onBattleEnd(ntf: any) {
        const role = ntf.role ?? getLoggedInRole() ?? this.registry.get('roleLocal') ?? {};
        this.registry.set('roleLocal', role);
        this.roleNameText.setText(`Name: ${role.name ?? '--'}`);
        this.roleZoneText.setText(`Zone:   ${role.zoneId ?? '--'}`);
        this.roleScoreText.setText(`Score:  ${role.score ?? 0}`);
        this.showToast(`Battle ended\nScore change: ${ntf.scoreChange ?? 0}`);
    }

    // ---- toast -------------------------------------------------------------

    private showToast(msg: string, isError = false) {
        const { width, height } = this.scale;
        const toastWidth = Math.min(width * 0.9, 360);
        const bg = new RoundRectangle(
            this,
            0,
            0,
            toastWidth,
            0,
            Radius.btn,
            isError ? Palette.danger : Palette.textPrimary,
            0.92,
        );
        this.add.existing(bg);
        // Toast message sits on a solid (danger or primary-dark) rounded
        // card — high contrast, no shadow needed.
        const text = this.add.text(0, 0, msg, {
            ...textStyle({
                size: FontSize.body,
                color: HexText.white,
                weight: 'semibold',
            }),
            wordWrap: { width: toastWidth - Spacing.lg * 2 },
            align: 'left',
        });
        const toast = this.rexUI.add.toast({
            x: width / 2,
            y: height - 80,
            background: bg,
            text,
            space: {
                left: Spacing.lg,
                right: Spacing.lg,
                top: Spacing.md,
                bottom: Spacing.md,
            },
            duration: { in: 200, hold: 3000, out: 300 },
        });
        toast.showMessage(msg);
    }
}
