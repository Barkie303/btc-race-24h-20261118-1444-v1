[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

# Washout-Recovery Breakout — cbBTC 24h race bot

A long-only bot that trades Coinbase Wrapped BTC (cbBTC) against USDC on
1-minute on-chain bars. It starts with $1,000 of paper money and races only
if it made money on the dev window.

## Strategy

On-chain cbBTC prices mean-revert hard after sharp selloffs, then fade. The
bot exploits that in two ways, one position at a time:

1. **Washout recovery (main).** When the price drops sharply over a short
   window — 0.60% in 10 minutes, 0.80% in 15, 1.00% in 30, or 1.50% in 60 —
   the bot buys the bounce at the next open with the full $1,000 and holds
   about 22 minutes, the window where the bounce is strongest before it
   fades. Take-profit +2.0%, stop-loss −1.5%.
2. **Slow-dip recovery (secondary).** When the price sits 0.60% or more below
   its 4-hour EMA, the bot buys a small $300 dip position and holds up to
   3 hours for the slow grind back toward the average. Take-profit +0.8%,
   stop-loss −1.0%.

Safety rails: 20-bar cooldown after every exit, no new entries in the last
40 bars of the window (a late entry would be flattened at a loss), max
slippage 2% per order.

## Why this shape

A full-size round trip costs about 32 bps (4 bps fee + 2 bps slippage +
~10 bps of pool impact each way), so a trade has to catch a move bigger than
that. One-minute noise is only ~7 bps, so fast EMA crosses just churn.
Sharp multi-minute drops, by contrast, bounce 40–90 bps in the next 15
minutes on the dev window — comfortably above the round-trip cost. The bot
therefore trades rarely (a handful of high-conviction entries a day) and
sits in cash the rest of the time.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only).
- `vendor/makefun-bars.ts` — the kit's bars-replay SDK shim, copied
  byte-for-byte.

## Run locally

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

## Dev result

Local harness grade on the published dev window: **net PnL +$13.98** (6
trades), which passes the dev gate (net PnL above $0).
