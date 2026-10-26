# Video Studio

A local studio for making AI videos with your own characters, run by [Claude Code](https://claude.com/claude-code) on a Mac.

- **Character swaps:** `/<character> <link>` takes a clip (YouTube, TikTok, X, Instagram, Kick or a file), finds the person you parody from context (never by face), swaps every shot of them for your character with Higgsfield, puts it back under the original audio and captions, upscales it to 1080p for free on the Mac, and files it in the library.
- **Original videos:** `/video <idea>` goes brief → storyboard and concept frames → Blender blockout → animatic → Higgsfield generation → review → edit → final.
- **The Video Studio app:** start sessions, follow every video's steps, answer approvals (with a notification and a Dock badge), and browse the library: search by what's said, originals side by side with conversions, approved and posted tracking, and an optional Buffer section for scheduling and comments.
- **Every paid job waits for your Approve.** Each one is priced first, a cheap test always goes before a full run, and background sessions can't spend a credit without your click.

It starts as a blank slate: no characters, no videos. You add your own.

## What you need

- A Mac (macOS 13 or newer; the free 1080p upscaler needs macOS 26) with [Homebrew](https://brew.sh) and the Xcode command-line tools (`xcode-select --install`)
- [Claude Code](https://claude.com/claude-code), signed in
- A [Higgsfield](https://higgsfield.ai) account for the paid generations (connected through the Higgsfield connector in Claude: claude.ai → Settings → Connectors)
- Optional: Blender (for `/video` blockouts), FilmCraft / EffectCraft / PhotoCraft (free, open source; colour matching, titles and retouching), a Buffer account (scheduling)

## Set it up

```bash
git clone https://github.com/topcat47/video-studio.git ~/video-studio
cd ~/video-studio
./setup.sh --install      # tools via Homebrew, folders, config, the always-on server, the Mac app
claude                    # then type: /setup
```

`setup.sh` is safe to run again; it never overwrites your config, library or characters. Leave out `--install` to only check the tools. `/setup` connects Higgsfield, offers the optional apps, and makes your first character and its swap skill with you.

Keep the folder outside Desktop and Documents if you can (macOS asks to allow `node` access to those).

## Using it

| | |
|---|---|
| `open -a "Video Studio"` | The app: ⌘1 Studio, ⌘2 Library, ⌘3 Buffer |
| `/<character> <link or file>` | A character swap (one skill per character, made by `/setup` or `scripts/new-swap-skill.sh`) |
| `/video <idea>` | An original video; `/video resume <slug>` picks it up again |
| `/run-videoapp` | Open the library, or restart the server if it's down |

Your settings are in `studio.config.json` (every field is explained in `studio.config.example.json`): social accounts, each character's posting voice for Buffer, extra source folders, the songs folder. Restart the server after editing it (`/run-videoapp` has the command).

## How it's built

No dependencies and no build step: a Node standard-library server (`video-library/server.js`), plain HTML pages, a small Swift app around them, and Python/Swift helper scripts. `CLAUDE.md` is the full map for Claude (and for you): the rules, the Studio, the code, the data model and the tests. Run the tests with `node --test --test-concurrency=1 video-library/test/*.test.js`; they use a throwaway copy and never touch your library.

## Use it responsibly

Swaps are for parody: an obviously fictional character in place of a public figure. Don't present a swap as the real person, don't use their name or handle as yours, respect the source creators' rights and each platform's rules, and keep each character's off-limits list. The skills stop when a provider refuses a job and never try to get around it.
