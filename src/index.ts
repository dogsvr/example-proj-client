// Entry file. Kept deliberately tiny so Parcel emits a minimal first-paint
// chunk: this file only imports `bootstrap`, which in turn pulls in
// tsrpc-browser and the login-form wiring but nothing Phaser-related.
//
// Phaser + rexUI + Colyseus + Matter are behind a dynamic `import()` inside
// bootstrap.ts and are only downloaded after the user clicks Login.

import('./bootstrap').then((m) => m.start());
