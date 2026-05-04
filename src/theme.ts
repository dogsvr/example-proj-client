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
    cardStroke: 0xD5DBDB,
    overlay: 0x2C3E50,
} as const;

/** CSS-style hex strings for Phaser Text fills (Phaser.Text.setStyle wants "#rrggbb"). */
export const HexText = {
    primary: '#2C3E50',
    secondary: '#7F8C8D',
    white: '#FFFFFF',
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
