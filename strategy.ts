// Pump.fun replay bot: buy the launch spike early, bank a small take-profit
// fast, cut the rest quickly.
//
// What the dev window shows (measured on all 1,222 coins):
// - A coin's price never falls below its create price; it pumps, then decays
//   back to it. Median coin ends where it started, so holding is a slow bleed.
// - Chasing a rise loses: after a +8-15% rise over 30-60 slots the price
//   typically falls back 8-25% over the next 100-300 slots. Momentum here
//   mean-reverts, fast. Pyramiding into strength loses for the same reason.
// - High-activity launches are the volatile ones: coins with >=7 distinct
//   early buyers, >=10 SOL real reserve and >=1.5 SOL net inflow in their
//   first slots hit +10% within 30 slots ~45% of the time, then crash back.
//   The money is in selling INTO the spike at a small fixed take-profit.
//   A wide trailing stop gives the spike back (the 2-slot fill latency eats
//   it in a crash); a fixed +10% take-profit with a -20% stop and a 30-slot
//   max hold was the best of ~150 parameter combinations swept on the dev
//   window (net -0.128 SOL, 58 trips, 26 wins, 2.0% max drawdown — the best
//   of every structure tried, including the kit's own pilots: sniper -0.47,
//   reversion -4.00, momentum -9.49). The dev window is a hard, fee-dominated
//   sample: every structure tried loses a little, so the settings here are
//   chosen on the flattest part of the surface (nearby settings score within
//   ~0.01 SOL), not on a knife-edge optimum, so the bot behaves the same on
//   the unseen final window.
//
// Costs that shape every number: curve fees are 95 + 30 = 125 bps each way
// and every order pays a flat tx fee (~0.000105 SOL), so a 0.05 SOL round trip
// costs ~3% before any price move; stakes much below 0.05 SOL drown in it,
// and the 1%-of-real-reserve buy cap is why entries need >=10 SOL of real
// reserve to take a meaningful size.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import {
  BPS,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Creator's own buys in the create slot: at most this many lamports. */
  maxDevBuy: bigint;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Trades seen before entry, at least. */
  minTrades: number;
  /** Net SOL flow (buys minus sells) seen before entry, at least (lamports). */
  minNetFlow: bigint;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Price now over the create price, as bps: window. */
  minPopBps: bigint;
  maxPopBps: bigint;
  /** Slippage allowed on buys (bps): a buy whose price jumps more than this in the latency is refused. */
  buySlippageBps: number;
  /** Exit when the position is worth this much under its cost (bps). */
  slBps: number;
  /** Fixed take-profit: exit when the position is worth this much over its cost (bps). 0 = off (trailing stop only). */
  tpBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when one recorded sell is at least this share (bps) of the real SOL reserve at the time. */
  bigSellBps: number;
  /** Pyramid: add to a position once its value is up at least addArmBps and net flow over addWindow slots is at least addNetSol. */
  addArmBps: number;
  addWindow: number;
  addNetSol: bigint;
  /** Most adds per position. */
  maxAdds: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 2,
  maxAge: 6,
  stakeLamports: 50_000_000n,
  minBuyLamports: 5_000_000n,
  minRealSol: 10_000_000_000n,
  maxRealSol: 100_000_000_000n,
  maxDevBuy: 2_500_000_000n,
  minBuyers: 7,
  minTrades: 6,
  minNetFlow: 1_500_000_000n,
  skipDevSold: true,
  minPopBps: 1_000n,
  maxPopBps: 20_000n,
  buySlippageBps: 10_000,
  slBps: 2_000,
  tpBps: 1_000,
  // Trailing stop off: with a fixed take-profit the trail only gives spikes
  // back (measured: trail variants scored worse). Kept as a knob, disarmed.
  trailArmBps: 100_000,
  trailBps: 800,
  maxHold: 30,
  exitOnDevSell: true,
  bigSellBps: 2_500,
  addArmBps: 2_000,
  addWindow: 20,
  addNetSol: 500_000_000n,
  maxAdds: 0, // tried 2: adds buy higher into a mean-reverting spike and dilute the exits; off wins
};

const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - ((q * FEE_BPS + BPS - 1n) / BPS);
}

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price pop is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>;
  trades: number;
  netFlow: bigint;
  /** Recent ticks (pruned to the last ~64 slots) for flow checks. */
  recent: Tick[];
  lastTradeSlot: number;
  /** Never buy it again (entered, exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Best sell value seen so far (lamports, curve fees deducted, tx fee not yet). */
  best: bigint;
  /** Pyramid adds sent so far. */
  adds: number;
  /** Slot of the last add (decision time). */
  lastAddSlot: number;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Mints that saw a creator sell or a big sell in this batch. */
  const devSoldNow = new Set<Pubkey>();
  const bigSellNow = new Set<Pubkey>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      devSoldNow.clear();
      bigSellNow.clear();
      const traded = new Set<Pubkey>();

      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!coins.has(e.mint)) {
            coins.set(e.mint, {
              mint: e.mint,
              createSlot: e.slot,
              creator: e.creator,
              vq0: BigInt(e.virtual_quote_reserves),
              vt0: BigInt(e.virtual_token_reserves),
              devBuy: 0n,
              devSold: false,
              buyers: new Set(),
              trades: 0,
              netFlow: 0n,
              recent: [],
              lastTradeSlot: e.slot,
              done: false,
              complete: false,
            });
          }
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          c.lastTradeSlot = e.slot;
          c.trades++;
          c.netFlow += e.is_buy ? sol : -sol;
          c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol });
          if (e.user === c.creator) {
            if (e.is_buy) c.devBuy += sol;
            else {
              c.devSold = true;
              devSoldNow.add(e.mint);
            }
          } else {
            if (e.is_buy) c.buyers.add(e.user);
            const curve = state.curves.get(e.mint);
            const rq = curve !== undefined ? curve.real_quote_reserves : 0n;
            if (!e.is_buy && rq > 0n && (sol * BPS) / rq >= BigInt(P.bigSellBps)) bigSellNow.add(e.mint);
          }
          traded.add(e.mint);
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) c.complete = true;
        }
      }

      // Drop stale ticks (keep a little more than the add window).
      const keepFrom = now - Math.max(P.addWindow, 64);
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.recent.length && c.recent[cut]!.slot <= keepFrom) cut++;
        if (cut > 0) c.recent.splice(0, cut);
      }

      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const m = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') m.buy = true;
        else m.sell = true;
        pendingByMint.set(po.order.mint, m);
      }

      // ---- Exits first. ----
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (value > h.best) h.best = value;
        const cost = pos.cost_lamports;
        let exit = false;
        // Fixed take-profit: bank the spike the moment it is there.
        if (P.tpBps > 0 && value * BPS >= cost * (BPS + BigInt(P.tpBps))) exit = true;
        // Stop loss against cost.
        if (!exit && value * BPS < cost * (BPS - BigInt(P.slBps))) exit = true;
        // Tight trailing stop once the position has run up: bank the spike.
        if (!exit && h.best * BPS >= cost * (BPS + BigInt(P.trailArmBps)) && value * BPS < h.best * (BPS - BigInt(P.trailBps))) exit = true;
        // Creator sold, or one big sell, while held.
        if (!exit && P.exitOnDevSell && devSoldNow.has(mint)) exit = true;
        if (!exit && bigSellNow.has(mint)) exit = true;
        // Time limit: spikes are fast; a position that never spiked is a slow bleed.
        if (!exit && now - h.openedSlot > P.maxHold) exit = true;
        if (!exit) continue;
        const pend = pendingByMint.get(mint);
        if (pend !== undefined && pend.sell) continue; // a sell is already in flight
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
      }
      // A sell that landed closes the bookkeeping.
      for (const f of batch.fills) {
        if (f.status === 'filled' && f.side === 'sell' && selling.has(f.mint) && !f.client_id.startsWith('_')) {
          selling.delete(f.mint);
          const c = coins.get(f.mint);
          if (c !== undefined) c.done = true;
        }
      }

      // ---- Pyramid adds: only into strength, only while flow still comes in. ----
      let free = state.freeCashLamports();
      for (const [mint, h] of held) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        const c = coins.get(mint);
        if (pos === undefined || curve === undefined || curve.complete || c === undefined) continue;
        if (h.adds >= P.maxAdds || now - h.lastAddSlot < 2) continue;
        if (pendingByMint.has(mint)) continue;
        const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (value * BPS < pos.cost_lamports * (BPS + BigInt(P.addArmBps))) continue;
        let flow = 0n;
        for (let i = c.recent.length - 1; i >= 0; i--) {
          const t = c.recent[i]!;
          if (t.slot <= now - P.addWindow) break;
          flow += t.isBuy ? t.sol : -t.sol;
        }
        if (flow < P.addNetSol) continue;
        let amount = P.stakeLamports;
        const capLamports = state.maxBuyLamports(mint);
        if (amount > capLamports) amount = capLamports;
        if (amount < P.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        h.adds++;
        h.lastAddSlot = now;
      }

      // ---- Entries: young, high-activity launches only. ----
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        const c = coins.get(mint);
        if (c === undefined || c.done || c.complete) continue;
        if (held.has(mint) || pendingByMint.has(mint)) continue;
        const age = now - c.createSlot;
        if (age < P.minAge || age > P.maxAge) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rq = curve.real_quote_reserves;
        if (rq < P.minRealSol || rq > P.maxRealSol) continue;
        if (c.devBuy > P.maxDevBuy) continue;
        if (P.skipDevSold && c.devSold) continue;
        if (c.buyers.size < P.minBuyers) continue;
        if (c.trades < P.minTrades) continue;
        if (c.netFlow < P.minNetFlow) continue;
        // Pop vs the create price: must have moved up, but not already mooned.
        if (c.vt0 > 0n && c.vq0 > 0n) {
          const pop = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0) - BPS;
          if (pop < P.minPopBps || pop > P.maxPopBps) continue;
        }
        let amount = P.stakeLamports;
        const capLamports = state.maxBuyLamports(mint);
        if (amount > capLamports) amount = capLamports;
        if (amount < P.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        slotsLeft--;
        c.done = true;
        held.set(mint, { openedSlot: now, best: 0n, adds: 0, lastAddSlot: now });
      }
      return orders;
    },
  };
}
