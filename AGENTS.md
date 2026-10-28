# Project working agreement

- Commit every iteration before ending work, including an unfinished but useful checkpoint. Describe unfinished work and any failing checks honestly in the commit message.
- Preserve the project's history. Do not amend, squash, rebase, or discard earlier commits unless the user explicitly asks.
- Keep changes small and commit messages concrete so earlier decisions and working versions remain easy to find.
- Follow the existing TRMNL repositories' commit style: lowercase Conventional Commit prefixes (`feat:`, `fix:`, `refactor:`, `style:`, `docs:`, `test:`, `chore:`), followed by a short imperative subject without a final period. Add a body only when it explains a meaningful behavior or validation detail. Examples: `refactor: group related pet display values`, `docs: regenerate plugin previews from current templates`.
- Use TRMNL Framework components, typography, and utilities for layout and presentation. Add custom CSS only when the framework cannot express the required behavior; verify previews with the pinned framework stylesheet and its actual fonts.
- Keep the common responsive display in `TRMNL/src/shared.liquid`. Keep all four view files nonempty (comment-only stubs are valid) because TRMNL can skip blank views. Preview full, half horizontal, half vertical, and quadrant layouts on OG, X, and OG B/W/R/Y in both orientations before claiming support.

Reference projects: [TRMNLGotchi](https://github.com/taichikuji/trmnl-tamagotchi-plugin), [HTTP Pets](https://github.com/taichikuji/trmnl-http-pets-plugin), and [TMB](https://github.com/taichikuji/trmnl-tmb-plugin).
