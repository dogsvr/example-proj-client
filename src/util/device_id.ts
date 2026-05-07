/**
 * Stable per-browser identifier, combined with display name into the server-facing
 * openId (= `${deviceId}:${name}`). Generated lazily via crypto.randomUUID when
 * available, fallback to Date.now + Math.random hex; persisted in localStorage.
 * localStorage failure → fresh per-session UUID.
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
        // localStorage unavailable (private mode / quota / disabled cookies).
        return genUuid();
    }
}

/** openId = `${deviceId}:${name.trim().slice(0, 32)}`. Caller must ensure name is non-empty. */
export function composeOpenId(deviceId: string, name: string): string {
    return `${deviceId}:${name.trim().slice(0, 32)}`;
}

function genUuid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Non-crypto fallback for older Safari.
    const rand32 = () =>
        Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    return `${Date.now().toString(16)}-${rand32()}-${rand32()}`;
}
