/**
 * Device-scoped stable identifier used to build the server-facing `openId`.
 *
 * The server's MongoDB role document is keyed on `{openId, zoneId}`, and the
 * login form used to accept a free-form openId from the user. That made the
 * account "identity" whatever string the user happened to type — brittle and
 * also leaked an internal routing key into the UI. Instead, we now:
 *
 *   - generate a random UUID once per browser and persist it in localStorage
 *     (the "device id"), and
 *   - combine it with the user-supplied display name to form the openId:
 *     `${deviceId}:${name}`.
 *
 * Consequences:
 *   - Same device + same name  => same role (existing behaviour preserved).
 *   - Same device + new name   => new role (name is part of identity; the
 *     server's existing-role branch does NOT rewrite `name` because the
 *     openId already encodes it).
 *   - New browser / cleared storage => new role (expected: there is no
 *     cross-device account system in this demo).
 *
 * Failure modes handled:
 *   - iOS Safari < 15.4 has no `crypto.randomUUID` — we fall back to a
 *     `Date.now` + `Math.random` hex string (not cryptographically strong,
 *     but sufficient for identifying a demo client).
 *   - Safari Private Browsing can throw on any localStorage access — we
 *     catch and return a per-session UUID so login still works (the user
 *     will just get a fresh role on every page refresh).
 */

const STORAGE_KEY = 'example-proj:deviceId';

export function getDeviceId(): string {
    try {
        const cached = localStorage.getItem(STORAGE_KEY);
        if (cached && cached.length >= 16) return cached;
        const fresh = genUuid();
        localStorage.setItem(STORAGE_KEY, fresh);
        return fresh;
    } catch {
        // localStorage unavailable (private mode, quota, disabled cookies).
        // Fall back to an ephemeral id; a page refresh will mint a new one
        // and thus a new role, which is an acceptable graceful degradation.
        return genUuid();
    }
}

/**
 * Compose the server-facing openId from a stable device id and the user's
 * chosen display name.
 *
 * - `name` is trimmed and capped at 32 chars to keep MongoDB keys bounded and
 *   to match the UI input `maxlength="32"`.
 * - The `:` separator is unambiguous: UUIDs only use `[0-9a-f-]`, so the
 *   boundary between deviceId and name never collides with deviceId content.
 * - Callers must validate that `name.trim()` is non-empty before invoking
 *   this function; we don't want `${uuid}:` openIds in the DB.
 */
export function composeOpenId(deviceId: string, name: string): string {
    return `${deviceId}:${name.trim().slice(0, 32)}`;
}

function genUuid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // iOS Safari < 15.4 fallback. Not cryptographically random, but this id
    // only has to be unique within a single demo deployment's userbase.
    const rand32 = () =>
        Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    return `${Date.now().toString(16)}-${rand32()}-${rand32()}`;
}
