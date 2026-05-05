/**
 * Central design tokens for the example-proj client.
 *
 * - `SceneBG` gives each top-level scene a distinct low-saturation gradient so
 *   users can visually tell them apart on scene switch. Values are `0xRRGGBB`
 *   Phaser-style integers (not CSS strings).
 * - `Palette` / `Spacing` / `Radius` are shared tokens meant to be imported by
 *   any scene or UI helper. Keep hard-coded colors out of scene files and
 *   reference tokens here instead so we can re-skin the whole client in one
 *   place.
 */

export const SceneBG = {
    /** main menu — mint mist, cool and neutral */
    main: { top: 0xEAF4F4, bottom: 0xC9E4E7 },
    /** state-sync battle — apricot warm sunlight */
    state: { top: 0xFFF3E2, bottom: 0xFFD6A5 },
    /** lockstep battle — lavender dusk */
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
    // Card outline. Kept deliberately on the darker side of neutral grey
    // (not the lighter 0xD5DBDB we used originally) so that white cards sit
    // clearly on top of pastel gradient scene backgrounds — a lighter stroke
    // reads as ~2:1 on apricot / lavender and the card edge dissolves,
    // which makes text inside the card look like it's floating over the
    // gradient rather than on a surface.
    cardStroke: 0xB0BCC2,
    overlay: 0x2C3E50,
} as const;

/** CSS-style hex strings for Phaser Text fills (Phaser.Text.setStyle wants "#rrggbb"). */
export const HexText = {
    primary: '#2C3E50',
    /**
     * Light secondary grey, used by DOM (login card help text, #app-loading
     * detail line). Low contrast on purpose — next to primary body text on
     * a white card, not on a gradient scene background.
     */
    secondary: '#7F8C8D',
    /**
     * Deeper secondary grey for Phaser scenes. The same `#7F8C8D` that
     * reads fine against a white DOM card fails WCAG AA contrast (~3:1)
     * when painted against our pastel gradient scene backgrounds. Use this
     * for FPS counters, zone labels, timestamps, any non-primary in-scene
     * text. Measures ~4.7:1 against the mint / apricot / lavender gradient
     * low points.
     */
    sceneSecondary: '#556270',
    white: '#FFFFFF',
    /**
     * Secondary text on a dark translucent surface (the battle HUD uses
     * textPrimary navy at alpha ~0.82 as its fill). Light steel grey —
     * measures ~5.0:1 against navy (WCAG AA) while still sitting visually
     * below pure white, so FPS-on-white vs. status-on-lightGrey gives a
     * proper "primary / secondary" readout hierarchy without needing a
     * different font weight.
     *
     * Not to be confused with `secondary` / `sceneSecondary`, both of
     * which are DARK greys used on light surfaces. On the navy HUD those
     * would be illegible; on a white card this one would be illegibly light.
     */
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

/**
 * Fixed-width button target: on phones we stretch to 80vw, on tablets / desktop
 * we cap at 320 so the menu doesn't become a comically wide banner.
 */
export function menuButtonWidth(screenWidth: number): number {
    return Math.min(screenWidth * 0.8, 320);
}

// ---------- Text style helper ---------------------------------------------

/**
 * Canonical font stack shared with the DOM login card in index.html. Keeps
 * San Francisco on Apple, Segoe UI on Windows, Roboto on Android, DejaVu
 * Sans on desktop Linux — and critically avoids bare `sans-serif`, which
 * defers to the browser's generic-family fallback and lands on whichever
 * ancient system font the OS happens to register (notable offender:
 * DejaVu Sans at small sizes on some Linux distros renders noticeably
 * softer than SF / Roboto at the same pixel size).
 */
export const FontStack =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * Capped device pixel ratio used for Phaser Text rasterization. Phaser 4
 * no longer accepts a game-level `resolution` config (unlike Phaser 3), so
 * crisp text is now a per-Text concern: every TextStyle returned by
 * `textStyle()` carries `resolution: textResolution()`, which mirrors the
 * device DPR and asks Phaser to bake the glyph atlas at that scale.
 *
 * Cap at 2 — iPhones report DPR=3 but that would have Phaser allocating a
 * 9× area canvas per Text object for essentially no perceptible win at
 * normal viewing distance; on mid-range phones the extra fill cost shows
 * up as dropped frames during scroll / heavy-HUD scenes.
 *
 * The cap is read once per Text creation. If a user somehow changes DPR
 * mid-session (dragging Chrome between monitors of different DPI), new
 * Text objects will pick up the new value but existing ones keep their
 * baked atlas. That's acceptable — not worth re-rastering every glyph.
 */
export function textResolution(): number {
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio ?? 1) : 1;
    return Math.min(Math.max(dpr, 1), 2);
}

export type Weight = 'regular' | 'semibold' | 'bold';

/**
 * Build a Phaser `TextStyle` config. Replaces the scattered inline object
 * literals that used to set `fontFamily`, `fontSize`, color, and (buggy)
 * weight for every `this.add.text()` call.
 *
 * Weight handling: Phaser 4 only exposes a `fontStyle` slot that it pastes
 * verbatim into the composed Canvas `font` shorthand string. Browsers
 * accept numeric weights (`'600'`, `'700'`) in that slot because the CSS
 * parser is lenient about shorthand order, but it's not standard — so
 * we centralize the string-building here. The alternative (using
 * `font: '600 14px SFPro, ...'`) is fragile in a different way because
 * Phaser's `font` field overrides `fontFamily`/`fontSize` separately, and
 * messes with later `setFontSize()` calls.
 *
 * Shadow: a subtle 1 px drop shadow lifts small text off the pastel
 * gradient backgrounds. Disabled by default for title-sized glyphs
 * (22px+) where the blur reads as grime. Pass `shadow: true` only for
 * caption / body sizes on gradient surfaces.
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
        // Numeric weight goes through `fontStyle` — see rationale above.
        fontStyle: weightMap[opts.weight ?? 'regular'],
        color: opts.color,
        resolution: textResolution(),
    };
    if (opts.shadow) {
        style.shadow = {
            offsetX: 0,
            offsetY: 1,
            color: 'rgba(0,0,0,0.18)',
            blur: 2,
            stroke: false,
            fill: true,
        };
    }
    return style;
}
