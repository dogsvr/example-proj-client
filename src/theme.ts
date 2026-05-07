/**
 * Design tokens for the example-proj client. Import from here; do NOT
 * hard-code colors in scenes.
 *
 * Values are 0xRRGGBB Phaser integers; `HexText.*` are CSS strings for
 * Phaser.Text fills.
 */

export const SceneBG = {
    /** main menu — mint mist */
    main: { top: 0xEAF4F4, bottom: 0xC9E4E7 },
    /** state-sync battle — apricot */
    state: { top: 0xFFF3E2, bottom: 0xFFD6A5 },
    /** lockstep battle — lavender */
    lockstep: { top: 0xE8E2F4, bottom: 0xB6A6E9 },
} as const;

export const Palette = {
    textPrimary: 0x2C3E50,
    textSecondary: 0x7F8C8D,
    accent: 0x5DADE2,
    accentDown: 0x3498DB,
    success: 0x58D68D,
    danger: 0xE57373,
    cardBg: 0xFFFFFF,
    // Darker than the lighter 0xD5DBDB option — lighter strokes visually
    // dissolve on pastel gradient backgrounds.
    cardStroke: 0xB0BCC2,
    overlay: 0x2C3E50,
} as const;

/** CSS hex strings for Phaser.Text fills. */
export const HexText = {
    primary: '#2C3E50',
    /** Light secondary for DOM (login card help text). Low contrast on purpose. */
    secondary: '#7F8C8D',
    /** Deeper secondary for in-scene Phaser text (FPS, zone labels); passes
     *  WCAG AA against pastel gradients where `secondary` does not. */
    sceneSecondary: '#556270',
    white: '#FFFFFF',
    /** Secondary text on a dark translucent HUD. Light steel; ~5:1 on navy. */
    onDarkSecondary: '#CFD8DC',
    danger: '#E57373',
} as const;

export const Spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const Radius = { btn: 12, card: 20 } as const;

export const FontSize = {
    caption: 14,
    body: 16,
    title: 22,
    hero: 28,
} as const;

/** Menu button width: 80vw on phones, capped at 320 on tablet/desktop. */
export function menuButtonWidth(screenWidth: number): number {
    return Math.min(screenWidth * 0.8, 320);
}

// ---------- Text style helper --------------------------------------------

/**
 * Shared with the DOM login card in index.html. Avoid bare `sans-serif` —
 * it falls back to the OS-registered generic family, which can land on
 * soft renders like DejaVu Sans at small sizes on some Linux distros.
 */
export const FontStack =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * DPR cap for Phaser Text rasterization. Phaser 4 removed the game-level
 * `resolution` config, so crisp text is now per-Text via TextStyle.resolution.
 *
 * Capped at 2: iPhones report DPR=3 but that would bake a 9× glyph atlas for
 * no perceptible win and shows up as dropped frames on mid-range phones.
 */
export function textResolution(): number {
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio ?? 1) : 1;
    return Math.min(Math.max(dpr, 1), 2);
}

export type Weight = 'regular' | 'semibold' | 'bold';

/**
 * Build a Phaser TextStyle.
 *
 * Weight is written into `fontStyle` (not `font`): Phaser's `font` shorthand
 * overrides fontFamily/fontSize separately and breaks later setFontSize().
 * Numeric weight strings ('600', '700') work because browsers accept them in
 * the CSS shorthand weight slot.
 *
 * `shadow: true` adds a subtle 1px drop shadow — use on caption/body over
 * gradients. Skip on titles (blur reads as grime at 22px+).
 */
export function textStyle(opts: {
    size: number;
    color: string;
    weight?: Weight;
    shadow?: boolean;
}): Phaser.Types.GameObjects.Text.TextStyle {
    const weightMap: Record<Weight, string> = {
        regular: '400',
        semibold: '600',
        bold: '700',
    };
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
        fontFamily: FontStack,
        fontSize: `${opts.size}px`,
        fontStyle: weightMap[opts.weight ?? 'regular'],
        color: opts.color,
        resolution: textResolution(),
    };
    if (opts.shadow) {
        style.shadow = {
            offsetX: 0, offsetY: 1,
            color: 'rgba(0,0,0,0.18)',
            blur: 2, stroke: false, fill: true,
        };
    }
    return style;
}
