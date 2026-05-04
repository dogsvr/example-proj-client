import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import RoundRectangle from 'phaser4-rex-plugins/plugins/roundrectangle.js';
import { Palette, Radius, Spacing, FontSize, HexText, SceneBG, menuButtonWidth } from '../theme';
import { paintGradientBackground } from '../ui/background';
import { showRankDialog } from '../ui/rank_dialog';
import { getLoggedInRole, queryRankList, registerBattleEndHandler, startBattle } from '../bootstrap';
import { getPreloadScene } from './preload_scene';

/**
 * Main menu scene. Layout is a vertical rexUI Sizer:
 *
 *   [role card]          <- top card: openId / zoneId / score
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
    private roleIdText!: Phaser.GameObjects.Text;
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

        this.roleIdText = this.add.text(0, 0, `OpenId: ${role.openId ?? '--'}`, {
            color: HexText.primary,
            fontSize: `${FontSize.body}px`,
            fontFamily: 'sans-serif',
        });
        this.roleZoneText = this.add.text(0, 0, `Zone:   ${role.zoneId ?? '--'}`, {
            color: HexText.secondary,
            fontSize: `${FontSize.body}px`,
            fontFamily: 'sans-serif',
        });
        this.roleScoreText = this.add.text(0, 0, `Score:  ${role.score ?? 0}`, {
            color: HexText.secondary,
            fontSize: `${FontSize.body}px`,
            fontFamily: 'sans-serif',
        });

        const textColumn = this.rexUI.add
            .sizer({ orientation: 'vertical', space: { item: Spacing.xs } })
            .add(this.roleIdText, { align: 'left' })
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
        const labelText = this.add.text(0, 0, text, {
            color: primary ? HexText.white : '#3498DB',
            fontSize: `${FontSize.body}px`,
            fontFamily: 'sans-serif',
            fontStyle: '600',
        });
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
        const versionText = this.add.text(0, 0, 'v0.1.0', {
            color: HexText.secondary,
            fontSize: `${FontSize.caption}px`,
            fontFamily: 'sans-serif',
        });
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
            showRankDialog(this, res);
        } catch (e: any) {
            this.showToast(`Query rank failed: ${e?.message ?? e}`, true);
        }
    }

    onBattleEnd(ntf: any) {
        const role = ntf.role ?? getLoggedInRole() ?? this.registry.get('roleLocal') ?? {};
        this.registry.set('roleLocal', role);
        this.roleIdText.setText(`OpenId: ${role.openId ?? '--'}`);
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
        const text = this.add.text(0, 0, msg, {
            color: HexText.white,
            fontSize: `${FontSize.body}px`,
            fontFamily: 'sans-serif',
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
