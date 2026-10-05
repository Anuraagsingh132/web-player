import { PlayerCore } from './engine/player-core.js';
import { PlayerUI } from './ui/player-ui.js';

document.addEventListener('DOMContentLoaded', () => {
  console.log('[WebVLC] Initializing Universal Web Media Player...');

  const videoElement = document.getElementById('mainVideo');
  const canvasElement = document.getElementById('mainCanvas');

  // Initialize Core Player
  const playerCore = new PlayerCore(videoElement, canvasElement);

  // Initialize UI Controller
  const playerUI = new PlayerUI(playerCore);

  // Expose to window for debugging and extensions
  window.WebVLC = {
    core: playerCore,
    ui: playerUI
  };

  console.log('[WebVLC] Player ready. WebCodecs, Web Audio API, and WASM media engines armed.');
});
