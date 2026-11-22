# Launch posts (drafts, not posted)

**Never put `@keywardhq/…` in post text**: X turns it into a mention of whoever owns @keywardhq (same problem gerra had). The command is in the video; in text, link the repo.

Same template as gerra's launch (see gerra's docs/launch-post.md for the research): "Introducing X" / one line of pain / "Fully open source" / a short video. Repo link in the first reply. No hashtags.

The timing hook is real and recent: Railway's Oct 21 breach went after customers' AI keys, and leaked-key bills are posted weekly. Don't claim keyward would have prevented a specific incident, and don't name people's bills as if they were ours.

## A. Main post (attach `docs/launch/keyward-launch.mp4`)

> Introducing keyward
>
> Your API keys are in more places than you think: git history, NEXT_PUBLIC_ vars, AI chat logs, shell history
>
> keyward finds every one, tells you which still work, rotates a leaked key everywhere in one paste, and freezes a key when its spend spikes
>
> Runs on your machine. Stores nothing. Fully open source

First reply:

> github.com/bottercode/keyward
>
> Checks talk only to the key's own provider; Vercel/Railway/GitHub updates go through your own CLIs, so it never holds your platform tokens.

## B. Reply / quote on leaked-key threads

> If you want to know where else that key lives (git history, .env files, AI chat transcripts, shell history) and whether it still works: I open-sourced a local tool for exactly this. Stores nothing.
>
> github.com/bottercode/keyward

Only on threads where someone is actually dealing with a leaked or stolen key. Substance first; no pitch on unrelated posts.

## C. Follow-up: the AI chat angle

> You pasted an API key into Claude Code / Codex / Cursor once to "just test something"
>
> It's still there, in plain text, in ~/.claude/projects
>
> keyward --home finds it (github.com/bottercode/keyward)
