# Launch video

`keyward-launch.mp4` (1920×1080, 15 s loop, for X) and `keyward-launch.gif` (960 px, for GitHub). Same style as gerra's launch: one idea per beat, a command typed large, no intro or end card beyond the name, no music (X autoplays muted).

Beats: "An API key is a credit card for compute." → `npx @keywardhq/cli ~/code --home` → four findings (a `NEXT_PUBLIC_` key in the browser bundle, a key deleted but still in git history, a committed Stripe key, a token pasted into a Claude Code chat) → which still work → rotate everywhere (files, Vercel, GitHub Actions) → keyward · find · check · rotate · freeze.

The keys and findings mirror what `scripts/demo.mjs` plants; every value is fake.

To re-render, with Google Chrome installed:

```bash
PAGE=index.html node capture.mjs 30 15 frames
ffmpeg -framerate 30 -i frames/f%04d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart keyward-launch.mp4
ffmpeg -i keyward-launch.mp4 -vf "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none" keyward-launch.gif
```
