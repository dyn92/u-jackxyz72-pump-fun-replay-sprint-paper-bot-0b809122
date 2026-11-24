// Early-launch spike scalper for the pump.fun replay (agent-fun/replay/v2).
//
// Buys only young, high-activity launches (7+ distinct early buyers, 10+ SOL
// real reserve, 1.5+ SOL net inflow in the first slots), 0.05 SOL each, and
// banks a fixed +10% take-profit fast; a -20% stop, a 30-slot max hold, and
// exits on creator sells / big sells cut the rest. See strategy.ts for the
// measured reasoning (dev window: net -0.128 SOL, 58 trips, 26 wins, 2.0% max
// drawdown — best of ~150 swept combinations and of the kit's own pilots).
//
// Run by the grader as `node /bot/main.ts`; the protocol shim is the kit's
// sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
