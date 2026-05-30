import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import RoundRectangle from 'phaser4-rex-plugins/plugins/roundrectangle.js';
import { Palette, Radius, Spacing, FontSize, HexText, SceneBG, menuButtonWidth, textStyle } from '../theme';
import { truncateName } from '../util/name_truncate';
import { paintGradientBackground } from '../ui/background';
import { showRankDialog } from '../ui/rank_dialog';
import { getLoggedInRole, onConnectionChange, queryRankList, registerBattleEndHandler, startBattle } from '../bootstrap';
import { getPreloadScene } from './preload_scene';

/**
 * Main menu scene: role card, 3 menu buttons, footer (connection dot + version).
 * Vertical rexUI Sizer, re-laid-out on every scale resize event.
 */
export class MainScene extends Phaser.Scene {
    rexUI!: UIPlugin;

    private root!: any;
    private roleNameText!: Phaser.GameObjects.Text;
    private roleZoneText!: Phaser.GameObjects.Text;
    private roleScoreText!: Phaser.GameObjects.Text;
    private connectionDot!: Phaser.GameObjects.Arc;

    constructor() { super({ key: 'main' }); }

    create() {
        paintGradientBackground(this, SceneBG.main.top, SceneBG.main.bottom);

        this.root = this.buildRoot();
        this.relayout();

        registerBattleEndHandler((ntf) => this.onBattleEnd(ntf));

        const unsubConn = onConnectionChange((connected) => this.drawConnectionDot(connected));

        this.cameras.main.fadeIn(250, 0xff, 0xff, 0xff);

        // scene.switch() sleeps rather than stops; re-run fadeIn on wake so we don't land on white.
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

        return this.rexUI.add
            .sizer({ orientation: 'vertical', space: { item: Spacing.lg } })
            .add(this.buildRoleCard(role, btnWidth), { align: 'center', expand: false })
            .add(this.buildMenu(btnWidth), { align: 'center', expand: false })
            .add(this.buildFooter(btnWidth), { align: 'center', expand: false });
    }

    private buildRoleCard(role: any, width: number): any {
        const bg = new RoundRectangle(this, 0, 0, width, 0, Radius.card, Palette.cardBg);
        bg.setStrokeStyle(1, Palette.cardStroke, 1);
        this.add.existing(bg);

        this.roleNameText = this.add.text(0, 0, '',
            textStyle({ size: FontSize.body, color: HexText.primary, weight: 'semibold' }));
        this.roleZoneText = this.add.text(0, 0, '',
            textStyle({ size: FontSize.body, color: HexText.sceneSecondary }));
        this.roleScoreText = this.add.text(0, 0, '',
            textStyle({ size: FontSize.body, color: HexText.sceneSecondary }));
        this.updateRoleCard(role);

        const textColumn = this.rexUI.add
            .sizer({ orientation: 'vertical', space: { item: Spacing.xs } })
            .add(this.roleNameText, { align: 'left' })
            .add(this.roleZoneText, { align: 'left' })
            .add(this.roleScoreText, { align: 'left' });

        return this.rexUI.add
            .sizer({
                orientation: 'horizontal',
                space: { left: Spacing.md, right: Spacing.md, top: Spacing.md, bottom: Spacing.md, item: Spacing.md },
            })
            .addBackground(bg)
            .add(textColumn, { proportion: 1, align: 'left', expand: true });
    }

    private updateRoleCard(role: any) {
        this.roleNameText.setText(`Name: ${truncateName(role.name) || '--'}`);
        this.roleZoneText.setText(`Zone:   ${role.zoneId ?? '--'}`);
        this.roleScoreText.setText(`Score:  ${role.score ?? 0}`);
    }

    private buildMenu(width: number): any {
        const buttons = this.rexUI.add.sizer({ orientation: 'vertical', space: { item: Spacing.md } });

        const addBtn = (label: string, handler: () => void | Promise<void>, primary = true) => {
            const btn = this.makeButton(label, width, primary);
            btn.on('pointerdown', async () => {
                btn.setScale(0.98);
                try { await handler(); } finally { btn.setScale(1); }
            });
            buttons.add(btn, { align: 'center' });
        };

        addBtn('Start Battle (state sync)', () => this.onStartBattle('state'));
        addBtn('Start Battle (state sync, raw)', () => this.onStartBattle('state', 'raw'));
        addBtn('Start Battle (lockstep)', () => this.onStartBattle('lockstep'));
        addBtn('Query Rank List', () => this.onQueryRank(), false);

        return buttons;
    }

    private makeButton(text: string, width: number, primary: boolean): any {
        const color = primary ? Palette.accent : Palette.cardBg;
        const bg = new RoundRectangle(this, 0, 0, 2, 2, Radius.btn, color);
        if (!primary) bg.setStrokeStyle(1, Palette.accent, 1);
        this.add.existing(bg);
        const labelText = this.add.text(0, 0, text,
            textStyle({
                size: FontSize.body,
                color: primary ? HexText.white : '#3498DB',
                weight: 'semibold',
            }));
        return this.rexUI.add.label({
            width, height: 56, background: bg, text: labelText, align: 'center',
            space: { left: Spacing.md, right: Spacing.md, top: 0, bottom: 0 },
        }).setInteractive({ useHandCursor: true });
    }

    private buildFooter(width: number): any {
        // circle() gives a GameObject with real width/height for Sizer;
        // Graphics has neither until an explicit setSize().
        this.connectionDot = this.add.circle(0, 0, 5, Palette.success);
        const versionText = this.add.text(0, 0, 'v0.1.0',
            textStyle({ size: FontSize.caption, color: HexText.sceneSecondary, shadow: true }));
        return this.rexUI.add
            .sizer({ orientation: 'horizontal', width, space: { item: Spacing.sm } })
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

        // Landscape / short-height fallback: downscale the root when the
        // vertical stack (~420px desired) doesn't fit. Never upscale.
        const desiredH = 420;
        const margin = Spacing.md * 2;
        const scale = Math.min(1, (height - margin) / desiredH);
        this.root.setScale(scale);

        this.root.setPosition(width / 2, height / 2);
    }

    // ---- actions -----------------------------------------------------------

    private async onStartBattle(syncType: 'state' | 'lockstep', variant: 'normal' | 'raw' = 'normal') {
        try {
            const res = await startBattle(syncType);
            this.registry.set('startBattleRes', res);
        } catch (e: any) {
            this.showToast(`Start battle failed: ${e?.message ?? e}`, true);
            return;
        }

        const preload = getPreloadScene(this.game);
        const [key, importer] = syncType === 'lockstep'
            ? ['lockstep_sync_battle', () => import('./lockstep_sync_battle_scene').then((m) => m.LockstepSyncBattleScene)]
            : variant === 'raw'
                ? ['state_sync_battle_raw', () => import('./state_sync_battle_raw_scene').then((m) => m.StateSyncBattleRawScene)]
                : ['state_sync_battle', () => import('./state_sync_battle_scene').then((m) => m.StateSyncBattleScene)] as const;
        try {
            const SceneClass = await preload.showProgressWhile('Loading battle…', (importer as () => Promise<any>)());
            if (!this.scene.get(key)) this.scene.add(key, SceneClass, false);
            // switch (not stop+run) puts main to SLEEP; battle does its own
            // fadeIn. Do NOT fadeOut main — it leaves main hidden after wake.
            this.scene.switch(key);
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
        this.updateRoleCard(role);
        this.showToast(`Battle ended\nScore change: ${ntf.scoreChange ?? 0}`);
    }

    // ---- toast -------------------------------------------------------------

    private showToast(msg: string, isError = false) {
        const { width, height } = this.scale;
        const toastWidth = Math.min(width * 0.9, 360);
        const bg = new RoundRectangle(this, 0, 0, toastWidth, 0, Radius.btn,
            isError ? Palette.danger : Palette.textPrimary, 0.92);
        this.add.existing(bg);
        const text = this.add.text(0, 0, msg, {
            ...textStyle({ size: FontSize.body, color: HexText.white, weight: 'semibold' }),
            wordWrap: { width: toastWidth - Spacing.lg * 2 },
            align: 'left',
        });
        const toast = this.rexUI.add.toast({
            x: width / 2,
            y: height - 80,
            background: bg,
            text,
            space: { left: Spacing.lg, right: Spacing.lg, top: Spacing.md, bottom: Spacing.md },
            duration: { in: 200, hold: 3000, out: 300 },
        });
        toast.showMessage(msg);
    }
}
