import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import RoundRectangle from 'phaser4-rex-plugins/plugins/roundrectangle.js';
import type { ZoneQueryRankListRes } from 'example-proj/protocols/cmd_proto';
import { Palette, Radius, Spacing, FontSize, HexText } from '../theme';

/**
 * Rank-list modal dialog.
 *
 * Structure:
 *
 *   ┌ backdrop (full-screen dim, blocks input) ───────────────┐
 *   │   ┌ dialog card (centered) ─────────────────────────┐   │
 *   │   │  Header: title                   [Close]        │   │
 *   │   │  ── column headers ──                           │   │
 *   │   │  Rank │ Name         │ Score │ Updated          │   │
 *   │   │  ── scrollable body (ScrollablePanel) ──        │   │
 *   │   │   1   │ Alice        │  1200 │ 2m ago           │   │
 *   │   │   2   │ Bob          │  1100 │ 5m ago           │   │
 *   │   │  ...                                            │   │
 *   │   │  ── footer ──                                   │   │
 *   │   │  You (#12)  Alice    1200   just now            │   │
 *   │   └─────────────────────────────────────────────────┘   │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Sizing rules:
 *   - Column widths are fixed (COL_WIDTHS) so header row and every body row
 *     line up. Total table width is the sum of column widths + spacing.
 *   - Dialog width = table width + horizontal padding, capped at 90% of
 *     screen width to stay mobile-friendly.
 *   - Dialog height = min(preferred, 80% of screen height). "Preferred" is
 *     enough to render all rows without scrolling. Beyond that threshold
 *     the ScrollablePanel kicks in and a vertical slider appears on the
 *     right.
 *
 * rexUI: we use ScrollablePanel with a vertical Sizer as its `child`. Each
 * row is a horizontal Sizer keyed off the same COL_WIDTHS as the header.
 * No custom virtualization — rank lists top out around a few hundred rows
 * and a plain DOM-like layout is fine at that scale.
 */

const COL_WIDTHS = { rank: 60, name: 150, score: 80, time: 100 };
const ROW_HEIGHT = 32;

interface RexScene extends Phaser.Scene {
    rexUI: UIPlugin;
}

export function showRankDialog(scene: RexScene, res: ZoneQueryRankListRes) {
    const W = scene.scale.width;
    const H = scene.scale.height;

    // --- compute geometry ---------------------------------------------------
    const tableWidth =
        COL_WIDTHS.rank + COL_WIDTHS.name + COL_WIDTHS.score + COL_WIDTHS.time + Spacing.md * 3;
    const dialogWidth = Math.min(tableWidth + Spacing.xl * 2, W * 0.9);
    // Preferred height: header + column row + all rows + footer + padding.
    const rowCount = res.rankList?.length ?? 0;
    const preferredBodyH = rowCount * ROW_HEIGHT;
    const maxBodyH = Math.max(H * 0.8 - 220, ROW_HEIGHT * 3);
    const bodyHeight = Math.min(preferredBodyH, maxBodyH);

    // --- full-screen modal backdrop ----------------------------------------
    const backdrop = scene.add
        .rectangle(0, 0, W, H, 0x000000, 0.5)
        .setOrigin(0, 0)
        .setDepth(9000)
        .setInteractive()
        .setScrollFactor(0);
    // Swallow clicks: without this, taps on the dim area would pass through
    // to scene objects underneath (main menu buttons).
    backdrop.on('pointerdown', () => { /* no-op, but consumes event */ });

    // --- dialog card background --------------------------------------------
    const cardBg = new RoundRectangle(scene, 0, 0, dialogWidth, 0, Radius.card, Palette.cardBg);
    cardBg.setStrokeStyle(1, Palette.cardStroke, 1);
    scene.add.existing(cardBg);

    // --- header -------------------------------------------------------------
    const title = scene.add.text(0, 0, 'Rank List', {
        color: HexText.primary,
        fontSize: `${FontSize.title}px`,
        fontFamily: 'sans-serif',
        fontStyle: '700',
    });

    const closeBg = new RoundRectangle(scene, 0, 0, 2, 2, Radius.btn, Palette.danger);
    scene.add.existing(closeBg);
    const closeText = scene.add.text(0, 0, '×', {
        color: HexText.white,
        fontSize: '20px',
        fontFamily: 'sans-serif',
        fontStyle: '700',
    });
    const closeBtn = scene.rexUI.add
        .label({
            width: 32,
            height: 32,
            background: closeBg,
            text: closeText,
            align: 'center',
        })
        .setInteractive({ useHandCursor: true });

    const header = scene.rexUI.add
        .sizer({
            orientation: 'horizontal',
            width: dialogWidth - Spacing.lg * 2,
            space: { item: Spacing.md },
        })
        .add(title, { align: 'left' })
        .addSpace()
        .add(closeBtn, { align: 'right' });

    // --- column header row --------------------------------------------------
    const columnHeader = buildRow(
        scene,
        ['Rank', 'Name', 'Score', 'Updated'],
        { header: true, self: false },
    );

    // --- scrollable body ---------------------------------------------------
    const bodyContent = scene.rexUI.add.sizer({
        orientation: 'vertical',
        space: { item: 2 },
    });
    if (rowCount === 0) {
        const empty = scene.add.text(0, 0, 'No data', {
            color: HexText.secondary,
            fontSize: `${FontSize.body}px`,
            fontFamily: 'sans-serif',
        });
        bodyContent.add(empty, { padding: { top: Spacing.lg, bottom: Spacing.lg } });
    } else {
        for (const member of res.rankList) {
            bodyContent.add(buildRow(scene, memberToCells(member), { header: false, self: false }), {
                align: 'left',
                expand: true,
            });
        }
    }

    const panelBg = new RoundRectangle(
        scene,
        0,
        0,
        2,
        2,
        Radius.btn / 2,
        0xffffff,
        0.4,
    );
    panelBg.setStrokeStyle(1, Palette.cardStroke, 1);
    scene.add.existing(panelBg);

    const trackBg = new RoundRectangle(scene, 0, 0, 6, 10, 3, Palette.cardStroke);
    scene.add.existing(trackBg);
    const thumb = new RoundRectangle(scene, 0, 0, 6, 10, 3, Palette.accent);
    scene.add.existing(thumb);

    const scrollPanel = scene.rexUI.add.scrollablePanel({
        width: dialogWidth - Spacing.lg * 2,
        height: bodyHeight,
        scrollMode: 0, // vertical
        background: panelBg,
        panel: {
            child: bodyContent,
            mask: { padding: 1 },
        },
        slider: {
            track: trackBg,
            thumb,
        },
        mouseWheelScroller: { focus: true, speed: 0.3 },
        space: {
            left: Spacing.sm,
            right: Spacing.sm,
            top: Spacing.xs,
            bottom: Spacing.xs,
            panel: 4,
        },
    });

    // --- self rank footer ---------------------------------------------------
    const selfLabel = scene.add.text(0, 0, 'You', {
        color: HexText.secondary,
        fontSize: `${FontSize.caption}px`,
        fontFamily: 'sans-serif',
    });
    const selfRow = buildRow(scene, memberToCells(res.selfRank), { header: false, self: true });
    const footer = scene.rexUI.add
        .sizer({
            orientation: 'vertical',
            width: dialogWidth - Spacing.lg * 2,
            space: { item: Spacing.xs },
        })
        .add(selfLabel, { align: 'left' })
        .add(selfRow, { align: 'left', expand: true });

    // --- assemble ----------------------------------------------------------
    const dialog = scene.rexUI.add
        .sizer({
            orientation: 'vertical',
            space: {
                left: Spacing.lg,
                right: Spacing.lg,
                top: Spacing.lg,
                bottom: Spacing.lg,
                item: Spacing.md,
            },
        })
        .addBackground(cardBg)
        .add(header, { align: 'center', expand: true })
        .add(columnHeader, { align: 'left', expand: true })
        .add(scrollPanel, { align: 'center', expand: true, proportion: 1 })
        .add(footer, { align: 'left', expand: true });

    dialog.setDepth(9001);
    dialog.layout();
    dialog.setPosition(W / 2, H / 2);

    // Scene-switch / resize cleanup.
    const destroyAll = () => {
        scene.scale.off(Phaser.Scale.Events.RESIZE, onResize);
        dialog.destroy();
        backdrop.destroy();
    };
    const onResize = () => {
        // Simplest response to a resize: just recenter. If the window becomes
        // smaller than the dialog, the backdrop stops covering the whole area,
        // which is acceptable for a demo.
        const w2 = scene.scale.width;
        const h2 = scene.scale.height;
        backdrop.setSize(w2, h2);
        dialog.setPosition(w2 / 2, h2 / 2);
    };
    scene.scale.on(Phaser.Scale.Events.RESIZE, onResize);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, destroyAll);
    scene.events.once(Phaser.Scenes.Events.SLEEP, destroyAll);

    closeBtn.on('pointerdown', destroyAll);
}

// --- helpers ---------------------------------------------------------------

function memberToCells(member: any): string[] {
    if (!member) return ['-', '-', '-', '-'];
    const rank = member.rank > 0 ? `#${member.rank}` : '—';
    const name = member.roleBriefInfo?.name || member.roleBriefInfo?.openId || '(anon)';
    const score = String(member.score ?? 0);
    const time = formatTs(member.updateTs);
    return [rank, name, score, time];
}

function formatTs(ts: number): string {
    if (!ts) return '—';
    const diff = Date.now() - ts * 1000;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * One table row. `header` = column-title style; `self` = accent-tinted row
 * used to highlight the viewer's own rank in the footer. The four cells are
 * laid out horizontally with fixed widths from COL_WIDTHS; each cell is a
 * rexUI `label` with an explicit `width`, which is how you get the cells to
 * line up consistently across header and body rows.
 */
function buildRow(
    scene: RexScene,
    cells: string[],
    opts: { header: boolean; self: boolean },
): any {
    const textColor = opts.header ? HexText.secondary : opts.self ? '#3498DB' : HexText.primary;
    const weight = opts.header || opts.self ? '700' : '400';
    const widths = [COL_WIDTHS.rank, COL_WIDTHS.name, COL_WIDTHS.score, COL_WIDTHS.time];
    const aligns: Array<'left' | 'right'> = ['left', 'left', 'right', 'right'];

    const row = scene.rexUI.add.sizer({
        orientation: 'horizontal',
        space: { item: Spacing.md, left: Spacing.sm, right: Spacing.sm, top: 4, bottom: 4 },
    });

    if (opts.self) {
        const bg = new RoundRectangle(scene, 0, 0, 2, 2, Radius.btn / 2, Palette.accent, 0.15);
        scene.add.existing(bg);
        row.addBackground(bg);
    }

    cells.forEach((cell, i) => {
        const txt = scene.add.text(0, 0, cell, {
            color: textColor,
            fontSize: `${FontSize.caption}px`,
            fontFamily: 'sans-serif',
            fontStyle: weight,
        });
        const cellLabel = scene.rexUI.add.label({
            width: widths[i],
            height: ROW_HEIGHT - 8,
            text: txt,
            align: aligns[i] === 'left' ? 'left' : 'right',
        });
        row.add(cellLabel);
    });

    return row;
}
