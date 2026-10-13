import './ui/styles.css';
import { App } from './app/App';

function showFatal(msg: string): void {
  const el = document.getElementById('overlay-root') ?? document.body;
  const box = document.createElement('div');
  box.className = 'modal-bg';
  box.innerHTML = `<div class="modal"><h2 class="title"><small>Fehler</small>Spiel kann nicht starten</h2><div class="error-box"></div><p style="color:#8d96a6;font-size:13px">Bitte einen aktuellen Browser (Chrome, Edge, Firefox) mit aktivierter Hardwarebeschleunigung verwenden.</p></div>`;
  (box.querySelector('.error-box') as HTMLElement).textContent = msg;
  el.appendChild(box);
}

window.addEventListener('error', (e) => console.error('Fehler:', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => console.error('Unbehandelte Promise-Ablehnung:', e.reason));

try {
  const app = new App(
    document.getElementById('canvas-root')!,
    document.getElementById('ui-root')!,
    document.getElementById('hud-root')!,
    document.getElementById('overlay-root')!,
  );
  (window as unknown as { __app: App }).__app = app;
} catch (e) {
  console.error(e);
  showFatal((e as Error).message);
}
