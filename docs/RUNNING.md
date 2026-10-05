# Running the game on your PC

The game runs in your web browser. Pick **one** of the two ways below.

## Option A: play it from a web link (no installs)

GitHub can host the game for you, and it rebuilds the link every time `main`
changes. It has to be switched on once:

1. Open the repository on GitHub, then **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab, open **Deploy to GitHub Pages**, and click
   **Run workflow** (or just wait for the next push to `main`).
4. When it finishes (about a minute), the game is at
   **https://infamase.github.io/OpusAI-Anomaly/**. Bookmark it.

GitHub Pages only works for a private repository on a paid GitHub plan. On
the free plan, the repository has to be public for this option; otherwise
use Option B.

## Option B: run it on your own PC (Windows)

You only do steps 1–2 once.

1. **Install Node.js.** Go to <https://nodejs.org>, download the **LTS**
   version (22 or newer), and run the installer with the default options.
2. **Get the game files.** Either:
   - **No Git:** on the GitHub repository page click **Code → Download ZIP**,
     then right-click the ZIP → **Extract All…** into a folder such as
     `Documents\OpusAI-Anomaly`; or
   - **With Git:** `git clone https://github.com/Infamase/OpusAI-Anomaly.git`
3. **Start it:** open the folder and double-click **`play.bat`**.
   - The first time, it installs what it needs (a minute or so, needs internet).
   - Your browser opens at `http://localhost:5173` with the game.
   - If Windows SmartScreen asks, click **More info → Run anyway** (it's a
     plain script; you can open it in Notepad to read it).
4. **Keep the black window open while you play.** Close it to stop the game.

To get updates later: download the ZIP again (or `git pull` in the folder),
then double-click `play.bat` again. Saves are kept in the browser, so they
survive updates. Use **Load Game → Export** to back one up.

### Mac / Linux

Install Node.js as above, then in a terminal inside the game folder run
`./play.sh`.

### By hand (any system)

```bash
npm install        # once
npm run dev        # then open http://localhost:5173
```

## Tips

- **Browser:** Chrome or Edge run it best (WebGPU). Firefox and others use
  WebGL automatically.
- **Sound** starts after your first click or key press (browsers block sound
  until then). Volumes are under **Options** on the title screen or the pause
  menu.
- **Performance:** press **F3** for the frame-rate overlay. If the picture is
  glitchy, set **Options → Renderer → WebGL** and restart.
- **Other PCs on your network** can play too: `play.bat` also prints a
  `Network:` address you can open on another computer.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `'node' is not recognized` / play.bat says Node.js is missing | Install Node.js (step 1), then close and re-open the folder window and try again. |
| Install fails | Check your internet connection; delete the `node_modules` folder and run `play.bat` again. |
| Browser doesn't open | Open `http://localhost:5173` yourself. |
| `Port 5173 is in use` | Another copy is already running: use that one, or close its window. Vite then picks the next port and prints it. |
| Black screen | Try another browser, or add `?renderer=webgl` to the address. |
