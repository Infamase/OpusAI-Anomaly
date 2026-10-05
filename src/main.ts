import './style.css';
import { Game } from './core/Game';
import { MainMenuScene } from './game/scenes/MainMenuScene';

const root = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const loadingText = loading.querySelector('.loading-text')!;

async function main(): Promise<void> {
  const game = new Game(root);
  await game.boot((msg) => (loadingText.textContent = msg));
  game.goToMainMenu = () => game.scenes.change(new MainMenuScene(game));
  await game.goToMainMenu();
  game.start();
  loading.remove();
  // Handy for poking at things from the browser console during development.
  (window as unknown as { game: Game }).game = game;
}

main().catch((err: unknown) => {
  console.error(err);
  loading.classList.add('error');
  loadingText.textContent = `Failed to start:\n${err instanceof Error ? err.message : String(err)}`;
});
