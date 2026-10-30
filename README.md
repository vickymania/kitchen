# Kitchen

A household app for recipes and a shared grocery list. Two installable web
apps (PWA) served by one Cloudflare Worker: a recipe book on `recipes.<your
domain>` and a live grocery list on `groceries.<your domain>`. The screens are
in Dutch and English.

This repository is a published snapshot of a private one: every release is
one commit here, with no history in between.

## What it does

- **Recipes**: ingredients, steps, photos, servings that scale, a cook mode
  that keeps the screen on, stars per person, cook statistics, and a "what
  shall I eat" wizard (meal, cuisine, time, main ingredient, carbs).
- **Recipe import with Claude**: a recipe from a web page (JSON-LD first,
  Claude when the page has none) or from photos of a cookbook page. Claude
  reads the text and picks and crops the dish photo; you get a draft first.
- **Shared grocery list**: every phone in the household sees a change within
  seconds. Lines are grouped per store, with suggestions while you type
  (other names, typos, words without spaces) and a basket for what is ticked.
- **Offline first**: each phone keeps its own copy and syncs through an
  operation log (`public/shared/ops.js`), so the list works in a shop without
  signal and two phones never overwrite each other.
- **Product knowledge**: the product you prefer per item, per store and per
  recipe, ratings per person, and "Laatst gekocht" (recently bought).
- **Receipts**: Albert Heijn and Lidl Plus receipts imported by a small
  fetcher on a home server, and a photo of any other receipt read by Claude.
- **Deals**: the weekly AH bonus and other stores' folders, matched against
  what you actually buy, with deal rules per item.
- **Shelf prices per store**: daily regular prices from the open
  [Checkjebon](https://github.com/supermarkt/checkjebon) data, matched to the
  exact products you buy, so a list line shows what it costs elsewhere.
- **Pantry**: bought minus cooked, use-by dates, "Bijna op" (running low),
  and usage rates that learn from what you use, so recurring things come back
  on the list by themselves ("Al nodig?").
- **Android widget**: the list per store on the home screen, with ticks and a
  quick add with suggestions (`android/`, Kotlin).
- **MCP server**: `mcp/server.mjs` lets Claude read and change recipes and the
  list through the same API and op engine as the phones.

## How it is built

| Part | Where |
|---|---|
| Worker (routes, auth, D1, photos in KV, Claude calls) | `worker/` |
| Shared logic (op engine, pantry, deals, suggestions), used by browser, worker and tools | `public/shared/` |
| Browser app (no build step, plain ES modules) | `public/app/`, `public/*.html`, `public/sw.js` |
| Database schema | `migrations/` (Cloudflare D1, SQLite) |
| Home-server fetcher (deals, receipts) | `fetcher/` (Node 22, no dependencies) |
| One-off and import tools | `tools/` |
| Android widget | `android/` |
| Tests | `tests/` |

There are no npm dependencies. The tests run the real worker on Node's
built-in SQLite (`tests/d1-shim.mjs`): same SQL, same migrations, same
handlers.

## Run it locally

You need Node 22 or newer and [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```sh
npm test                                  # all tests, Node's own runner
cp wrangler.example.jsonc wrangler.jsonc  # then fill in ids and host names
npx wrangler d1 migrations apply kitchen --local
npx wrangler dev --env dev --port 8787
```

Open http://recipes.localhost:8787 and http://groceries.localhost:8787. The
worker picks the app by the host name (`groceries.` or anything else).

Create the household and the first device code:

```sh
node tools/admin.mjs bootstrap --name Sam --household Home --local
```

This prints a six-digit code to pair a phone and stores a token for the tools
and the MCP server in `mcp/.env` (git-ignored). More codes, for another device
or a new person: `node tools/admin.mjs code`.

## Deploy with your own Cloudflare account

1. Create a D1 database and a KV namespace:
   `npx wrangler d1 create kitchen` and `npx wrangler kv namespace create PHOTOS`.
2. Put their ids and your two host names in `wrangler.jsonc`.
3. For the Claude features (receipt photos, recipe import, labels, shelf
   lives): `npx wrangler secret put ANTHROPIC_API_KEY`. Never put the key in a file.
4. Commit, then `node tools/deploy.mjs`: it runs the tests, applies the
   migrations and deploys with the commit as the build id, so the phones'
   service workers pick up the new version.
5. `node tools/admin.mjs bootstrap --name <you> --household <name>` once.

The Android widget talks to the origin in
`android/app/src/main/java/works/vexed/groceries/Api.kt`; change it to your
groceries host before you build it. The fetcher reads its origin from
`fetcher/config.env` (see `fetcher/config.example.env`).

## Example data

The receipt imports map products to list items with reviewed tables
(`tools/ah_items.mjs`, `tools/lidl_items.mjs`). The ones here are small
fictional examples; build your own from your receipts with the import's dry
run, which lists every guess.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE): free for personal, non-commercial
use. Read the licence for what counts as non-commercial.
