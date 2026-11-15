# makefun-markdown-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/lblanda/makefun-markdown-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/lblanda/makefun-markdown-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast drop-in replacement for marked 18.1.3, written for the make.fun
markdown-render-speed-02 bounty: `parse.js` renders exactly the HTML that
marked renders with its default options (GFM on), byte for byte — but faster.
`main.ts` reads every case from `/input/cases.json` and writes the HTML for
each to `/output/html.json`.

## Run it

```sh
MAKEFUN_INPUT_DIR=./cases MAKEFUN_OUTPUT_DIR=./out node main.ts
```

## Layout

- `parse.js` — the renderer: a from-scratch Markdown parser that reproduces
  marked 18.1.3's output exactly (blocks, inline, tables, footnotes of
  behaviour included), written for speed: index-cursor scanning, first-char
  dispatch, and a single-pass inline scanner.
- `main.ts` — the driver the harness runs.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?ref=3zwarjv0&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
