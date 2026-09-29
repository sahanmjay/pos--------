---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: ["style.css","app.js"]
---

# Surface brief: NexPOS app shell (all screens)

Scope: whole app visual system (login, shell, POS checkout, back-office screens, Super Admin). Mode: Operate.
Audience/job: cashiers finishing sales fast on touch and mouse; owners reviewing sales, stock, staff. Layout (sidebar, products left, cart right, mobile tab bar) is fixed by PRODUCT.md.

History: a bold "Lorry Sign Painter" direction (seed 2169ef35) was built and rejected by the user as "cartoon". The user then asked for premium but simple, which is the category standard executed carefully (canon). Reference bar: Square POS, Shopify POS, Stripe dashboard.

## Direction contract

THESIS: Premium through restraint. Neutral surfaces, one quiet accent that follows the Settings theme, and hierarchy made by weight and size rather than colour, so the only loud thing on the till is the number being charged. It refuses loud colour fields, all-caps display lettering and decorative outlines.

OWN-WORLD: One zinc-neutral ramp (--g0 to --g9) for every grey; the accent (--brand) defaults to emerald #047857 with white text (--on-brand), used for primary actions, active nav, the total and focus and becomes blue, emerald or rose from Settings; Midnight flips the ramp. Inter (self-hosted, variable), sentence case, weights 450-700, tabular figures. 1px #E4E4E7 borders, 8-12px radii, soft offset shadows. Category tiles carry soft tints (50-shade ground, 600-shade icon); status colour is used for state (green in stock, amber low, red offline or out), always with a word.

STORY: The cashier scans a calm grid of product cards (neutral image tile, name, unit and code, price), taps to add (the count badge appears), reads the large Total, and presses the one dark Cash Payment button. The owner sees the same cards and tables, quiet and aligned.

FIRST VIEWPORT: POS at 1440x900. A 56px white top bar with a hairline border; a 236px light-grey sidebar where the active item is a white raised row. The product area on #F6F6F7 holds 164px+ cards with 84px neutral image tiles. A 384px white cart: "Current Order" header, customer select, two-line item rows with pill steppers, then Total at 28px/700 beside a dashed rule, and a full-width 52px graphite "Cash Payment" button as the primary action, with Card and Credit as outlined buttons below.

FORM: Canon, the category standard executed at full craft (user chose it in plain words after rejecting the rolled direction). Motion: 150-220ms exponential ease-out, no idle loops except the syncing dot and overdue kitchen timers.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
