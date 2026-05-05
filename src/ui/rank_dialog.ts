import Phaser from 'phaser';
import type UIPlugin from 'phaser4-rex-plugins/templates/ui/ui-plugin.js';
import RoundRectangle from 'phaser4-rex-plugins/plugins/roundrectangle.js';
import type { ZoneQueryRankListRes, RankMember, RoleBriefInfo } from 'example-proj/protocols/cmd_proto';
import { Palette, Radius, Spacing, FontSize, HexText, textStyle, type Weight } from '../theme';

/**
 * Rank-list modal dialog.
 *
 * Structure:
 *
 *   ┌ backdrop (full-screen dim, blocks input) ───────────────┐
 *   │   ┌ dialog card (centered) ─────────────────────────┐   │
 *   │   │  Header: title                   [Close]        │   │
 *   │   │  ── scrollable body (ScrollablePanel) ──        │   │
 *   │   │   Rank │ Name   │ Score │ Updated  ◀ col header │   │
 *   │   │    1   │ Alice  │  1200 │ 2m ago               │   │
 *   │   │    2   │ Bob    │  1100 │ 5m ago               │   │
 *   │   │  ...                                            │   │
 *   │   │  ▸ horizontal slider (visible when overflowing) │   │
 *   │   │  ── footer (my rank, horizontally linked) ──    │   │
 *   │   │  You                                            │   │
 *   │   │   12  │ Me     │  950  │ just now              │   │
 *   │   └─────────────────────────────────────────────────┘   │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Sizing rules (responsive — UI Design Rules §1, §4):
 *   - All four columns are always rendered. On wide screens columns expand
 *     by PROPORTION to fill the dialog width ("fit mode"). When the dialog
 *     is too narrow to fit every column at its MIN_WIDTH ("overflow mode"),
 *     each column stays at its minimum and the body becomes horizontally
 *     scrollable; the user swipes (touch) or drags (mouse) to reveal the
 *     rightmost columns. A horizontal slider below the list makes the
 *     overflow state discoverable — native scroll gutters are invisible
 *     in a WebGL canvas.
 *   - The column-header row lives **inside** the ScrollablePanel so it
 *     tracks the body horizontally without manual sync. It does scroll
 *     off the top when the list is tall enough to require vertical
 *     scroll; at typical top-N rank sizes this is rare.
 *   - The "You" footer row lives in its own horizontal-only
 *     ScrollablePanel whose childOX is two-way-mirrored with the main
 *     panel, so whichever direction the user scrolls, the footer stays
 *     aligned column-for-column with the list above it.
 *   - Dialog height = min(preferred, 80 % of screen height). Beyond the
 *     threshold the ScrollablePanel scrolls vertically.
 *
 * rexUI: we use ScrollablePanel with a vertical Sizer as its `child`. Each
 * row is a horizontal Sizer keyed off the same column widths as the header.
 * No custom virtualization — rank lists top out around a few hundred rows
 * and a plain DOM-like layout is fine at that scale.
 *
 * Extending with a new column: add its ColKey to `COL_KEYS`, then add an
 * entry in `MIN_WIDTH` / `PROPORTION` / `HEADER_LABELS` / `alignForKey` /
 * `memberToCells`. No other code change is required.
 */

type ColKey = 'rank' | 'name' | 'score' | 'time';

/** Canonical column order, rendered left-to-right. */
const COL_KEYS: ColKey[] = ['rank', 'name', 'score', 'time'];

/**
 * Minimum pixel width a column may shrink to in "fit mode". In "overflow
 * mode" the column is pinned at exactly this value and the row overflows
 * the dialog horizontally.
 */
const MIN_WIDTH: Record<ColKey, number> = { rank: 44, name: 90, score: 56, time: 72 };

/**
 * Relative share of the remaining (after minimums are allocated) table
 * budget in "fit mode". Name grows fastest since display names are the
 * dominant visual. Ignored in overflow mode.
 */
const PROPORTION: Record<ColKey, number> = { rank: 1, name: 4, score: 1.5, time: 2 };

/** Row vertical size. Hit-zone concerns don't apply: rows are read-only. */
const ROW_HEIGHT = 32;

/**
 * Fixed vertical cost of everything in the dialog that's NOT the scroll
 * panel: outer `Spacing.lg` top + title row (44) + `Spacing.md` gap below
 * title + `Spacing.md` gap above footer + footer (selfLabel 18 + xs gap
 * 4 + inner panel 40) + outer `Spacing.lg` bottom. Measures to 186 px;
 * we reserve 190 for a small rounding / descent buffer. Used to convert
 * viewport height to the ScrollablePanel height — bumping this number
 * too tight clips the close button, too loose wastes rows.
 */
const DIALOG_CHROME = 190;

/**
 * Dialog occupies this fraction of viewport height. Modal convention is
 * ~0.90; we pick 0.94 so the rank panel fills as much of the phone
 * screen as possible (leaving just a narrow rim of dim backdrop visible
 * to communicate "tap outside to dismiss" / "this is a modal").
 */
const DIALOG_V_RATIO = 0.94;

/**
 * Floor for the scroll panel height even on tiny viewports (rotated phone
 * at 375×320). Five rows is the smallest that still communicates "this
 * is a list" at a glance.
 */
const MIN_VISIBLE_ROWS = 5;

interface ColumnSpec {
    keys: ColKey[];
    widths: Record<ColKey, number>;
    /**
     * Total horizontal pixel width a rendered row consumes, including
     * inter-cell gaps and per-row left/right padding. Callers pass this
     * to the body Sizer's `minWidth` so the content doesn't get squashed
     * back to the viewport width in overflow mode.
     */
    totalWidth: number;
    /** True when every column is at its MIN_WIDTH and rows will overflow. */
    overflow: boolean;
}

/**
 * Compute each column's pixel width given how much horizontal space the
 * list area has to spend. Two modes:
 *
 *   - **fit**: `tableBudget` comfortably covers the sum of MIN_WIDTHs plus
 *     inter-cell gaps and row padding. Remaining slack is divided among
 *     columns by PROPORTION so the row exactly fills the budget.
 *   - **overflow**: budget is smaller than the four-column minimum. Each
 *     column stays at MIN_WIDTH; the returned `totalWidth` will exceed
 *     `tableBudget` and the ScrollablePanel scrolls horizontally.
 *
 * `screenWidth` is accepted for future tuning (e.g. tightening MIN_WIDTHs
 * on extremely narrow phones) but is currently unused; keeping it in the
 * signature avoids a breaking call-site change if that tuning is added.
 */
function computeColumns(tableBudget: number, _screenWidth: number): ColumnSpec {
    const keys: ColKey[] = COL_KEYS;

    const itemGap = Spacing.md * (keys.length - 1);
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
    const totalWidth = colsSum + overhead;

    return { keys, widths, totalWidth, overflow };
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

    // --- responsive geometry -----------------------------------------------
    // Cap the dialog at 540 to keep it a comfortable reading width on desktop
    // while hugging 92 % of the viewport on phones (was 90 %, bumped so the
    // narrow-layout fit at W=320 still has breathing room).
    const dialogWidth = Math.min(540, W * 0.92);
    // The ScrollablePanel configured below adds `Spacing.sm` padding on each
    // side; that padding shrinks the panel's inner drawable width. We
    // subtract it here so fit mode computes column widths that exactly fill
    // the drawable area — otherwise fit-mode content would overflow the
    // inner width by 2×Spacing.sm and report a spurious horizontal overflow.
    const scrollPanelPadH = Spacing.sm * 2;
    const tableBudget = dialogWidth - Spacing.lg * 2 - scrollPanelPadH;
    const columns = computeColumns(tableBudget, W);

    // Body height: we deliberately DO NOT shrink to fit the row count. In
    // this demo Redis may only have a handful of registered players and a
    // content-driven height would collapse the dialog to a tiny strip on
    // screen — which reads as "something's broken" rather than "short
    // list". Instead every rank dialog occupies the same tall modal
    // footprint (DIALOG_V_RATIO of the viewport); unfilled vertical space
    // shows as blank panel background. This matches Spotlight / iOS
    // search sheet / macOS open-file modal behaviour.
    //
    // MIN_VISIBLE_ROWS is the absolute floor for extreme viewports
    // (landscape phones around 375×320).
    const rowCount = res.rankList?.length ?? 0;
    const bodyHeight = Math.max(
        H * DIALOG_V_RATIO - DIALOG_CHROME,
        ROW_HEIGHT * MIN_VISIBLE_ROWS,
    );

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
    // Dialog content lives on a white card over a dimmed backdrop — no
    // shadow needed, contrast is already high.
    const title = scene.add.text(0, 0, 'Rank List',
        textStyle({ size: FontSize.title, color: HexText.primary, weight: 'bold' }));

    // 44×44 per UI Design Rules §3 (touch hit-zone minimum).
    const closeBg = new RoundRectangle(scene, 0, 0, 2, 2, Radius.btn, Palette.danger);
    scene.add.existing(closeBg);
    const closeText = scene.add.text(0, 0, '×',
        textStyle({ size: 22, color: HexText.white, weight: 'bold' }));
    const closeBtn = scene.rexUI.add
        .label({
            width: 44,
            height: 44,
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
    // The header lives INSIDE the scrollable body so it scrolls horizontally
    // in lock-step with the data rows — no need to mirror offsets manually.
    // In overflow mode this keeps `Rank / Name / Score / Updated` labels
    // perfectly aligned with their columns as the user swipes right.
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

    // --- scrollable body ---------------------------------------------------
    // bodyContent has its width pinned to `columns.totalWidth` so that in
    // overflow mode (totalWidth > visible inner width) the sizer does not
    // collapse rows back to the viewport. When fit, totalWidth equals the
    // inner width and this pin is a no-op.
    const bodyContent = scene.rexUI.add.sizer({
        orientation: 'vertical',
        width: columns.totalWidth,
        space: { item: 2 },
    });
    bodyContent.add(columnHeader, { align: 'left', expand: false });
    if (rowCount === 0) {
        const empty = scene.add.text(0, 0, 'No data',
            textStyle({ size: FontSize.body, color: HexText.secondary }));
        bodyContent.add(empty, { padding: { top: Spacing.lg, bottom: Spacing.lg } });
    } else {
        for (const member of res.rankList) {
            bodyContent.add(
                buildRow(scene, memberToCells(member, columns.keys), columns, {
                    header: false,
                    self: false,
                }),
                { align: 'left', expand: false },
            );
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

    // Y-axis slider (existed before). Separate X-axis slider shown only when
    // rows overflow horizontally — in fit mode there's nothing to scroll
    // horizontally and the slider would be a visually confusing dead zone.
    const trackBgY = new RoundRectangle(scene, 0, 0, 6, 10, 3, Palette.cardStroke);
    scene.add.existing(trackBgY);
    const thumbY = new RoundRectangle(scene, 0, 0, 6, 10, 3, Palette.accent);
    scene.add.existing(thumbY);

    // scrollMode 2 ("xy") enables both axes; each axis gets its own scroller
    // (touch / mouse drag), slider (visual + draggable), and optional
    // mouse-wheel scroller. rexUI's Scroller internally performs dominant-
    // axis detection on touch, so a vertical swipe won't leak into X and
    // vice-versa — essential for iOS Safari where scroll gestures are
    // ambiguous. We attach a mouse wheel scroller to Y only (the usual
    // vertical scroll affordance); horizontal wheel events are uncommon and
    // would otherwise hijack two-finger trackpad pans.
    let scrollPanelCfg: any = {
        width: dialogWidth - Spacing.lg * 2,
        height: bodyHeight,
        scrollMode: 2, // xy — see comment above
        background: panelBg,
        panel: {
            child: bodyContent,
            mask: { padding: 1 },
        },
        sliderY: {
            track: trackBgY,
            thumb: thumbY,
            hideUnscrollableSlider: true,
        },
        mouseWheelScrollerY: { focus: true, speed: 0.3 },
        space: {
            left: Spacing.sm,
            right: Spacing.sm,
            top: Spacing.xs,
            bottom: Spacing.xs,
            panel: 4,
            sliderY: 2,
        },
    };
    if (columns.overflow) {
        const trackBgX = new RoundRectangle(scene, 0, 0, 10, 6, 3, Palette.cardStroke);
        scene.add.existing(trackBgX);
        const thumbX = new RoundRectangle(scene, 0, 0, 10, 6, 3, Palette.accent);
        scene.add.existing(thumbX);
        scrollPanelCfg.sliderX = {
            track: trackBgX,
            thumb: thumbX,
            hideUnscrollableSlider: true,
        };
        scrollPanelCfg.space.sliderX = 2;
    }
    const scrollPanel = scene.rexUI.add.scrollablePanel(scrollPanelCfg);

    // --- self rank footer ---------------------------------------------------
    // The footer row must stay aligned column-for-column with the list
    // above it, so it lives in its own horizontal-only ScrollablePanel
    // whose childOX we mirror against the main panel.
    const selfLabel = scene.add.text(0, 0, 'You',
        textStyle({ size: FontSize.caption, color: HexText.secondary }));
    const selfRow = buildRow(
        scene,
        memberToCells(resolveSelfMember(res, role), columns.keys),
        columns,
        { header: false, self: true },
    );
    const selfRowContainer = scene.rexUI.add.sizer({
        orientation: 'vertical',
        width: columns.totalWidth,
        space: { item: 0 },
    });
    selfRowContainer.add(selfRow, { align: 'left', expand: false });

    // The footer ScrollablePanel has no sliders / mouse wheel of its own —
    // those would compete with the main body panel (e.g. vertical wheel
    // hovering over the footer would be swallowed). Users can still drag
    // the footer horizontally; we mirror any change back into the main
    // body so the two stay in sync regardless of which one the user
    // interacts with.
    const footerPanel = scene.rexUI.add.scrollablePanel({
        width: dialogWidth - Spacing.lg * 2,
        height: ROW_HEIGHT + Spacing.xs * 2,
        scrollMode: 1, // horizontal only
        panel: {
            child: selfRowContainer,
            mask: { padding: 1 },
        },
        space: {
            left: Spacing.sm,
            right: Spacing.sm,
            top: Spacing.xs,
            bottom: Spacing.xs,
            panel: 0,
        },
    });

    // Two-way horizontal sync between body and footer. The `scroll` event
    // (scrollMode 1) / `scrollX` event (scrollMode 2) fires from slider /
    // scroller `valuechange`; `setChildOX` does NOT emit it, so there is
    // no feedback loop.
    let syncing = false;
    const mirrorTo = (target: any, childOX: number) => {
        if (syncing) return;
        syncing = true;
        target.setChildOX(childOX, true);
        syncing = false;
    };
    scrollPanel.on('scrollX', () => mirrorTo(footerPanel, scrollPanel.childOX));
    footerPanel.on('scroll', () => mirrorTo(scrollPanel, footerPanel.childOX));

    const footer = scene.rexUI.add
        .sizer({
            orientation: 'vertical',
            width: dialogWidth - Spacing.lg * 2,
            space: { item: Spacing.xs },
        })
        .add(selfLabel, { align: 'left' })
        .add(footerPanel, { align: 'left', expand: true });

    // --- assemble ----------------------------------------------------------
    // Note: the column header is NOT added to the outer dialog Sizer any
    // more — it lives inside scrollPanel's content so it tracks X-scroll.
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
        .add(scrollPanel, { align: 'center', expand: true, proportion: 1 })
        .add(footer, { align: 'left', expand: true });

    dialog.setDepth(9001);
    dialog.layout();
    dialog.setPosition(W / 2, H / 2);

    // Scene-switch / resize cleanup.
    // On resize we don't just recenter — a large enough width change can
    // flip between fit and overflow modes or change every column's share.
    // The simplest correct reaction is to tear down the dialog and re-open
    // it; the rank data is already in memory and a brief re-render beats
    // a stale layout with mismatched column widths.
    let rebuildTimer: Phaser.Time.TimerEvent | null = null;
    const destroyAll = () => {
        scene.scale.off(Phaser.Scale.Events.RESIZE, onResize);
        if (rebuildTimer) rebuildTimer.remove(false);
        dialog.destroy();
        backdrop.destroy();
    };
    const onResize = () => {
        const w2 = scene.scale.width;
        const h2 = scene.scale.height;
        // Always resize the backdrop immediately so the modal cover stays
        // flush with the viewport.
        backdrop.setSize(w2, h2);
        dialog.setPosition(w2 / 2, h2 / 2);
        // Debounce the heavier rebuild: resize fires many times during a
        // window drag / orientation flip.
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
        name: member.roleBriefInfo?.name || '(anon)',
        score: String(member.score ?? 0),
        time: formatTs(member.updateTs),
    };
    return keys.map((k) => all[k]);
}

/**
 * Pick the right source for the "You" footer row:
 *   1. If the caller's gid is present in the current rankList window, reuse
 *      that entry verbatim so the footer agrees with the list row for the
 *      same player.
 *   2. Otherwise splice local role identity (name/gid) onto the server's
 *      selfRank (which carries score/updateTs/rank but no roleBriefInfo).
 *   3. If we have no local role at all, fall back to res.selfRank unchanged
 *      (pre-change behaviour — degrades to "(anon)" but doesn't crash).
 */
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

/**
 * One table row. `header` = column-title style; `self` = accent-tinted row
 * used to highlight the viewer's own rank in the footer. Column widths are
 * computed per-dialog (not per-row) — see computeColumns — and passed in so
 * header and body rows always agree.
 */
function buildRow(
    scene: RexScene,
    cells: string[],
    columns: ColumnSpec,
    opts: { header: boolean; self: boolean },
): any {
    const textColor = opts.header ? HexText.secondary : opts.self ? '#3498DB' : HexText.primary;
    // Header row + "self" accent row render bold; regular body rows stay
    // at normal weight for comfortable reading of long rank lists.
    const weight: Weight = opts.header || opts.self ? 'bold' : 'regular';
    const alignForKey: Record<ColKey, 'left' | 'right'> = {
        rank: 'left',
        name: 'left',
        score: 'right',
        time: 'right',
    };

    const row = scene.rexUI.add.sizer({
        orientation: 'horizontal',
        space: { item: Spacing.md, left: Spacing.sm, right: Spacing.sm, top: 4, bottom: 4 },
    });

    if (opts.self) {
        const bg = new RoundRectangle(scene, 0, 0, 2, 2, Radius.btn / 2, Palette.accent, 0.15);
        scene.add.existing(bg);
        row.addBackground(bg);
    }

    columns.keys.forEach((key, i) => {
        const txt = scene.add.text(0, 0, cells[i],
            textStyle({ size: FontSize.caption, color: textColor, weight }));
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
