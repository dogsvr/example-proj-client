import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import RoundRectangle from 'phaser4-rex-plugins/plugins/roundrectangle.js';
import type { ZoneQueryRankListRes, RankMember, RoleBriefInfo } from 'example-proj/protocols/cmd_proto';
import { Palette, Radius, Spacing, FontSize, HexText, textStyle, type Weight } from '../theme';
import { truncateName, fitTextToWidth } from '../util/name_truncate';

/**
 * Rank-list modal: 4 columns (Rank/Name/Score/Updated). Fits columns by
 * PROPORTION when there's budget; falls back to MIN_WIDTH + horizontal
 * scroll on narrow viewports, with a compact self-rank digest in the footer.
 */

type ColKey = 'rank' | 'name' | 'score' | 'time';

const COL_KEYS: ColKey[] = ['rank', 'name', 'score', 'time'];
const MIN_WIDTH: Record<ColKey, number> = { rank: 44, name: 50, score: 56, time: 72 };
const PROPORTION: Record<ColKey, number> = { rank: 1, name: 4, score: 1.5, time: 2 };

const ROW_HEIGHT = 32;
/** Fixed vertical cost of everything NOT in the scroll panel (chrome + padding + footer). */
const DIALOG_CHROME = 190;
/** Dialog occupies this fraction of viewport height. */
const DIALOG_V_RATIO = 0.94;
/** Floor for visible rows on tiny viewports (rotated phone ~375×320). */
const MIN_VISIBLE_ROWS = 5;

interface ColumnSpec {
    keys: ColKey[];
    widths: Record<ColKey, number>;
    /** Full row width including item gaps and row padding. */
    totalWidth: number;
    /** True when every column is at MIN_WIDTH; body scrolls horizontally. */
    overflow: boolean;
}

function computeColumns(tableBudget: number): ColumnSpec {
    const keys: ColKey[] = COL_KEYS;

    const itemGap = Spacing.sm * (keys.length - 1);
    const rowPadding = Spacing.sm * 2;
    const overhead = itemGap + rowPadding;

    const minSum = keys.reduce((s, k) => s + MIN_WIDTH[k], 0);
    const propSum = keys.reduce((s, k) => s + PROPORTION[k], 0);
    const available = Math.max(0, tableBudget - overhead);

    const widths = {} as Record<ColKey, number>;
    const overflow = available < minSum;

    if (overflow) {
        for (const k of keys) widths[k] = MIN_WIDTH[k];
    } else {
        const extra = available - minSum;
        for (const k of keys) {
            widths[k] = Math.floor(MIN_WIDTH[k] + (extra * PROPORTION[k]) / propSum);
        }
    }

    const colsSum = keys.reduce((s, k) => s + widths[k], 0);
    return { keys, widths, totalWidth: colsSum + overhead, overflow };
}

interface RexScene extends Phaser.Scene {
    rexUI: UIPlugin;
}

export function showRankDialog(
    scene: RexScene,
    res: ZoneQueryRankListRes,
    role?: Partial<RoleBriefInfo>,
) {
    const W = scene.scale.width;
    const H = scene.scale.height;

    // Dialog width: 92% of viewport (for 320px fit), capped at 540 on desktop.
    const dialogWidth = Math.min(540, W * 0.92);
    // ScrollablePanel adds Spacing.sm padding on each side; subtract here so
    // fit-mode column widths exactly fill the drawable area.
    const scrollPanelPadH = Spacing.sm * 2;
    const tableBudget = dialogWidth - Spacing.lg * 2 - scrollPanelPadH;
    const columns = computeColumns(tableBudget);

    // Viewport-driven body height so short lists still render a full modal.
    const bodyHeight = Math.max(
        H * DIALOG_V_RATIO - DIALOG_CHROME,
        ROW_HEIGHT * MIN_VISIBLE_ROWS,
    );

    const backdrop = scene.add
        .rectangle(0, 0, W, H, 0x000000, 0.5)
        .setOrigin(0, 0)
        .setDepth(9000)
        .setInteractive()
        .setScrollFactor(0);
    // Swallow clicks so taps on the dim area don't fall through to the scene.
    backdrop.on('pointerdown', () => { /* no-op, consumes event */ });

    const cardBg = new RoundRectangle(scene, 0, 0, dialogWidth, 0, Radius.card, Palette.cardBg);
    cardBg.setStrokeStyle(1, Palette.cardStroke, 1);
    scene.add.existing(cardBg);

    const title = scene.add.text(0, 0, 'Rank List',
        textStyle({ size: FontSize.title, color: HexText.primary, weight: 'bold' }));

    // 44×44 per UI Design Rules (touch hit-zone minimum).
    const closeBg = new RoundRectangle(scene, 0, 0, 2, 2, Radius.btn, Palette.danger);
    scene.add.existing(closeBg);
    const closeText = scene.add.text(0, 0, '×',
        textStyle({ size: 22, color: HexText.white, weight: 'bold' }));
    const closeBtn = scene.rexUI.add
        .label({ width: 44, height: 44, background: closeBg, text: closeText, align: 'center' })
        .setInteractive({ useHandCursor: true });

    const header = scene.rexUI.add
        .sizer({ orientation: 'horizontal', width: dialogWidth - Spacing.lg * 2, space: { item: Spacing.md } })
        .add(title, { align: 'left' })
        .addSpace()
        .add(closeBtn, { align: 'right' });

    // Column header lives INSIDE the scrollable body so it scrolls in lock-step.
    const HEADER_LABELS: Record<ColKey, string> = {
        rank: 'Rank',
        name: 'Name',
        score: 'Score',
        time: 'Updated',
    };
    const columnHeader = buildRow(
        scene,
        columns.keys.map((k) => HEADER_LABELS[k]),
        columns,
        { header: true, self: false },
    );

    // bodyContent width pinned to columns.totalWidth so overflow mode rows
    // don't collapse back to the viewport width.
    const bodyContent = scene.rexUI.add.sizer({
        orientation: 'vertical',
        width: columns.totalWidth,
        space: { item: 2 },
    });
    bodyContent.add(columnHeader, { align: 'left', expand: false });
    const rowCount = res.rankList?.length ?? 0;
    if (rowCount === 0) {
        const empty = scene.add.text(0, 0, 'No data',
            textStyle({ size: FontSize.body, color: HexText.secondary }));
        bodyContent.add(empty, { padding: { top: Spacing.lg, bottom: Spacing.lg } });
    } else {
        for (const member of res.rankList) {
            bodyContent.add(
                buildRow(scene, memberToCells(member, columns.keys), columns,
                    { header: false, self: false }),
                { align: 'left', expand: false },
            );
        }
    }

    const panelBg = new RoundRectangle(scene, 0, 0, 2, 2, Radius.btn / 2, 0xffffff, 0.4);
    panelBg.setStrokeStyle(1, Palette.cardStroke, 1);
    scene.add.existing(panelBg);

    const trackBgY = new RoundRectangle(scene, 0, 0, 6, 10, 3, Palette.cardStroke);
    scene.add.existing(trackBgY);
    const thumbY = new RoundRectangle(scene, 0, 0, 6, 10, 3, Palette.accent);
    scene.add.existing(thumbY);

    // scrollMode 2 = xy. `enableLayer: true` batches scissor-mask so per-row
    // allocs don't tank scroll perf past ~50 rows.
    let scrollPanelCfg: any = {
        width: dialogWidth - Spacing.lg * 2,
        height: bodyHeight,
        scrollMode: 2,
        background: panelBg,
        panel: { child: bodyContent, mask: { padding: 1 }, enableLayer: true },
        sliderY: { track: trackBgY, thumb: thumbY, hideUnscrollableSlider: true },
        mouseWheelScrollerY: { focus: true, speed: 0.3 },
        space: {
            left: Spacing.sm, right: Spacing.sm, top: Spacing.xs, bottom: Spacing.xs,
            panel: 4, sliderY: 2,
        },
    };
    if (columns.overflow) {
        const trackBgX = new RoundRectangle(scene, 0, 0, 10, 6, 3, Palette.cardStroke);
        scene.add.existing(trackBgX);
        const thumbX = new RoundRectangle(scene, 0, 0, 10, 6, 3, Palette.accent);
        scene.add.existing(thumbX);
        scrollPanelCfg.sliderX = { track: trackBgX, thumb: thumbX, hideUnscrollableSlider: true };
        scrollPanelCfg.space.sliderX = 2;
    }
    const scrollPanel = scene.rexUI.add.scrollablePanel(scrollPanelCfg);

    // Footer "You" row: table-aligned in fit mode, one-line digest in overflow mode.
    const selfLabel = scene.add.text(0, 0, 'You',
        textStyle({ size: FontSize.caption, color: HexText.secondary }));

    let selfRowChild: any;
    if (columns.overflow) {
        const selfMember = resolveSelfMember(res, role);
        const digest = memberToCells(selfMember, columns.keys).join('  ·  ');
        selfRowChild = scene.add.text(0, 0, digest,
            textStyle({ size: FontSize.caption, color: '#3498DB', weight: 'bold' }));
    } else {
        selfRowChild = buildRow(
            scene,
            memberToCells(resolveSelfMember(res, role), columns.keys),
            columns,
            { header: false, self: true },
        );
    }

    const footer = scene.rexUI.add
        .sizer({
            orientation: 'vertical',
            width: dialogWidth - Spacing.lg * 2,
            space: { item: Spacing.xs },
        })
        .add(selfLabel, { align: 'left' })
        .add(selfRowChild, { align: 'left', expand: false });

    const dialog = scene.rexUI.add
        .sizer({
            orientation: 'vertical',
            space: {
                left: Spacing.lg, right: Spacing.lg, top: Spacing.lg, bottom: Spacing.lg,
                item: Spacing.md,
            },
        })
        .addBackground(cardBg)
        .add(header, { align: 'center', expand: true })
        .add(scrollPanel, { align: 'center', expand: true, proportion: 1 })
        .add(footer, { align: 'left', expand: true });

    dialog.setDepth(9001);
    dialog.layout();
    dialog.setPosition(W / 2, H / 2);

    // On resize a big width change may flip fit↔overflow; tear down and
    // re-open is simpler than in-place reflow. Debounced.
    let rebuildTimer: Phaser.Time.TimerEvent | null = null;
    let destroyed = false;
    const destroyAll = () => {
        if (destroyed) return;
        destroyed = true;
        scene.scale.off(Phaser.Scale.Events.RESIZE, onResize);
        // Unregister SHUTDOWN/SLEEP once listeners so × close doesn't leak them.
        scene.events.off(Phaser.Scenes.Events.SHUTDOWN, destroyAll);
        scene.events.off(Phaser.Scenes.Events.SLEEP, destroyAll);
        if (rebuildTimer) rebuildTimer.remove(false);
        dialog.destroy();
        backdrop.destroy();
    };
    const onResize = () => {
        const w2 = scene.scale.width;
        const h2 = scene.scale.height;
        backdrop.setSize(w2, h2);
        dialog.setPosition(w2 / 2, h2 / 2);
        if (rebuildTimer) rebuildTimer.remove(false);
        rebuildTimer = scene.time.delayedCall(120, () => {
            destroyAll();
            showRankDialog(scene, res, role);
        });
    };
    scene.scale.on(Phaser.Scale.Events.RESIZE, onResize);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, destroyAll);
    scene.events.once(Phaser.Scenes.Events.SLEEP, destroyAll);

    closeBtn.on('pointerdown', destroyAll);
}

// --- helpers ---------------------------------------------------------------

function memberToCells(member: any, keys: ColKey[]): string[] {
    if (!member) return keys.map(() => '-');
    const all: Record<ColKey, string> = {
        rank: member.rank > 0 ? `#${member.rank}` : '—',
        name: truncateName(member.roleBriefInfo?.name) || '(anon)',
        score: String(member.score ?? 0),
        time: formatTs(member.updateTs),
    };
    return keys.map((k) => all[k]);
}

/** Pick "You" source: matching gid on page → local role → res.selfRank. */
function resolveSelfMember(
    res: ZoneQueryRankListRes,
    role: Partial<RoleBriefInfo> | undefined,
): RankMember {
    if (!role?.gid) return res.selfRank;
    const onPage = res.rankList?.find((m) => m.roleBriefInfo?.gid === role.gid);
    if (onPage) return onPage;
    return {
        ...res.selfRank,
        roleBriefInfo: { gid: role.gid, name: role.name ?? '' },
    };
}

function formatTs(ts: number): string {
    if (!ts) return '—';
    const diff = Date.now() - ts * 1000;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** One table row. Column widths come from computeColumns so header/body agree. */
function buildRow(
    scene: RexScene,
    cells: string[],
    columns: ColumnSpec,
    opts: { header: boolean; self: boolean },
): any {
    const textColor = opts.header ? HexText.secondary : opts.self ? '#3498DB' : HexText.primary;
    const weight: Weight = opts.header || opts.self ? 'bold' : 'regular';
    const alignForKey: Record<ColKey, 'left' | 'right'> = {
        rank: 'left', name: 'left', score: 'right', time: 'right',
    };

    const row = scene.rexUI.add.sizer({
        orientation: 'horizontal',
        space: { item: Spacing.sm, left: Spacing.sm, right: Spacing.sm, top: 4, bottom: 4 },
    });

    if (opts.self) {
        const bg = new RoundRectangle(scene, 0, 0, 2, 2, Radius.btn / 2, Palette.accent, 0.15);
        scene.add.existing(bg);
        row.addBackground(bg);
    }

    columns.keys.forEach((key, i) => {
        const txt = scene.add.text(0, 0, cells[i],
            textStyle({ size: FontSize.caption, color: textColor, weight }));
        // Pixel-level fallback: even within NAME_MAX_CHARS, 6 CJK glyphs
        // (~84px) overflow the 50px min name column. Trim until it fits.
        fitTextToWidth(txt, columns.widths[key]);
        const cellLabel = scene.rexUI.add.label({
            width: columns.widths[key],
            height: ROW_HEIGHT - 8,
            text: txt,
            align: alignForKey[key] === 'left' ? 'left' : 'right',
        });
        row.add(cellLabel);
    });

    return row;
}
