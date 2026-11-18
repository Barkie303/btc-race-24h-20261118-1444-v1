// Washout-Recovery Breakout bot for cbBTC (CBBTC/USDC, 1-minute bars).
//
// Idea: on-chain cbBTC prices mean-revert hard after sharp selloffs and then
// fade. The bot does two things, both long-only, one position at a time:
//   1. Washout recovery (main): after a sharp multi-minute drop, buy the
//      bounce at the next open and hold ~22 minutes, the window where the
//      bounce is strongest before it fades.
//   2. Slow-dip recovery (secondary): when the price sits well below its
//      4-hour EMA, buy a small dip position and hold up to 3 hours for the
//      slow grind back toward the average.
// Everything is integer math (bigint), no clock, no randomness, no network,
// so two runs on the same bars produce the same orders.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Washout triggers: (lookback bars, minimum drop in bps, negative).
const WASHOUTS: Array<[number, bigint]> = [
  [10, -60n], // -0.60% in 10 minutes
  [15, -80n], // -0.80% in 15 minutes
  [30, -100n], // -1.00% in 30 minutes
  [60, -150n], // -1.50% in 60 minutes
];

// Secondary dip: price this far below the 240-bar EMA (bps).
const DIP_GAP_BPS = 60n;
const DIP_EMA_BARS = 240;

// Position sizes (USDC raw units, 1e6 per USDC).
const WASHOUT_SIZE = 1_000_000_000n; // whole $1,000 starting capital
const DIP_SIZE = 300_000_000n; // $300

// Exits, in bps and bars.
const WASHOUT_TP_BPS = 200n; // +2.0%
const WASHOUT_SL_BPS = 150n; // -1.5%
const WASHOUT_MAX_HOLD = 22; // bars
const DIP_TP_BPS = 80n; // +0.8%
const DIP_SL_BPS = 100n; // -1.0%
const DIP_MAX_HOLD = 180; // bars

const COOLDOWN_BARS = 20; // bars to wait after an exit before re-entering
const WINDOW_BARS = 1440; // bars in the competition window (24h x 60min)
const NO_ENTRY_LAST_BARS = 40; // never open a position this close to the end
const MAX_SLIPPAGE_BPS = 200; // 2% from the latest close

const BPS = 10_000n;
const EMA_SCALE = 1_000_000n;

type Mode = 'washout' | 'dip' | null;

const closes: bigint[] = [];
let emaScaled = 0n; // 240-bar EMA of closes, scaled by EMA_SCALE
let mode: Mode = null;
let pendingMode: Mode = null;
let entryPrice = 0n; // raw price units of the fill that opened the position
let peakPrice = 0n; // highest close seen while holding
let entrySeq = -1;
let lastExitSeq = -1_000_000;

function returnBps(now: bigint, then: bigint): bigint {
  return ((now - then) * BPS) / then;
}

function isWashout(): boolean {
  const n = closes.length;
  const now = closes[n - 1];
  for (const [lookback, threshold] of WASHOUTS) {
    if (n > lookback && returnBps(now, closes[n - 1 - lookback]) <= threshold) {
      return true;
    }
  }
  return false;
}

function isDip(): boolean {
  if (closes.length <= DIP_EMA_BARS || emaScaled === 0n) return false;
  const now = closes[closes.length - 1];
  const gapBps = ((emaScaled - now * EMA_SCALE) * BPS) / emaScaled;
  return gapBps >= DIP_GAP_BPS;
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  // Fold in the fills of the orders decided on the previous batch.
  for (const fill of batch.fills) {
    if (fill.status === 'filled' && fill.side === 'buy') {
      entryPrice = BigInt(fill.price);
      peakPrice = entryPrice;
      entrySeq = state.seq;
      mode = pendingMode;
      pendingMode = null;
    } else if (fill.status === 'filled' && fill.side === 'sell') {
      mode = null;
      pendingMode = null;
      entryPrice = 0n;
      peakPrice = 0n;
      lastExitSeq = state.seq;
    } else if (fill.status === 'rejected') {
      pendingMode = null;
    }
  }

  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];
  const close = BigInt(bar.c);
  closes.push(close);

  // Update the slow EMA (integer math, deterministic).
  if (emaScaled === 0n) {
    emaScaled = close * EMA_SCALE;
  } else {
    emaScaled += ((close * EMA_SCALE - emaScaled) * 2n) / BigInt(DIP_EMA_BARS + 1);
  }

  const position = state.positions.get(SYMBOL);
  const heldQty = position?.qty ?? 0n;

  if (heldQty > 0n && mode !== null && entryPrice > 0n) {
    if (close > peakPrice) peakPrice = close;
    const hold = state.seq - entrySeq;
    const gainBps = returnBps(close, entryPrice);
    const tp = mode === 'washout' ? WASHOUT_TP_BPS : DIP_TP_BPS;
    const sl = mode === 'washout' ? WASHOUT_SL_BPS : DIP_SL_BPS;
    const maxHold = mode === 'washout' ? WASHOUT_MAX_HOLD : DIP_MAX_HOLD;
    if (gainBps >= tp || gainBps <= -sl || hold >= maxHold) {
      return [{ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: look for an entry. Washout takes priority over the dip.
  if (state.warmingUp) return [];
  if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
  if (state.seq >= WINDOW_BARS - NO_ENTRY_LAST_BARS) {
    // Near the end of the window; the position would be flattened anyway.
    return [];
  }

  const washout = isWashout();
  const dip = !washout && isDip();
  if (!washout && !dip) return [];

  const size = washout ? WASHOUT_SIZE : DIP_SIZE;
  const notional = size < state.cash ? size : state.cash;
  if (notional < 1_000_000n) return [];
  pendingMode = washout ? 'washout' : 'dip';
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({ onBatch });
