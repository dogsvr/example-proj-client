/**
 * Name-truncation utilities. Two layers:
 *   - truncateName: character-level cap (legacy long names).
 *   - fitTextToWidth: pixel-level fallback (≤cap but still overflows a column).
 *
 * Runtime-zero by design: `Phaser` is used as TYPE only (via `import type`),
 * so first-paint modules (bootstrap.ts) can import NAME_MAX_CHARS / truncateName
 * without dragging Phaser into the login bundle.
 */

import type Phaser from 'phaser';

/** Name cap: ≤6 code points (1 CJK = 1). Input validation + display cap. */
export const NAME_MAX_CHARS = 6;

/** Ellipsis character (U+2026). Single code point; respects font kerning. */
const ELLIPSIS = '…';

/**
 * Truncate by Unicode code point (not UTF-16 code unit), appending "…" when
 * trimmed. `String.slice` splits surrogate pairs, so use Array.from.
 */
export function truncateName(name: string | undefined | null, max = NAME_MAX_CHARS): string {
    if (!name) return '';
    const chars = Array.from(name);
    return chars.length <= max ? name : chars.slice(0, max).join('') + ELLIPSIS;
}

/**
 * Pixel-level fit: shrink a Phaser Text one code point at a time, appending
 * "…", until it fits `maxWidth`. Mutates in place. Used when a fixed-width
 * column needs to clamp visually even for names already ≤NAME_MAX_CHARS
 * (6 CJK glyphs ≈84px can still overflow a 50px column).
 */
export function fitTextToWidth(txt: Phaser.GameObjects.Text, maxWidth: number): void {
    if (txt.width <= maxWidth) return;
    const chars = Array.from(txt.text);
    while (chars.length > 0) {
        chars.pop();
        txt.setText(chars.join('') + ELLIPSIS);
        if (txt.width <= maxWidth) return;
    }
    // Column too narrow even for "…"; leave it (clipped by label width).
}
