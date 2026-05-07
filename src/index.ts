// Entry: minimal first-paint chunk. Imports bootstrap (tsrpc-browser + login
// wiring); Phaser is behind a dynamic import() inside bootstrap.ts.
import('./bootstrap').then((m) => m.start());
