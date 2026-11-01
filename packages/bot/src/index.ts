// Midstrike, the bot: a player of Keeps that sees only its own seat's view and log, keeps a belief about what it can't
// see (belief.ts, history.ts), and plays its trained network (policy.ts, entity.ts) on the observations it encodes
// (observation.ts, observation2.ts; actions.ts turns a move into the network's action ids). env.ts is a round as the
// network was trained on it, and fingerprint.ts hashes what the network sees, so weights refuse to run against another
// encoding. worlds.ts samples the hidden deals consistent with what a seat knows, for the search.
//
// The rest is imported by path (`@keeps/bot/search/search.ts`), as some of it runs only in Node:
//   search/   the search (sampled worlds, every candidate played out; pools of threads, or the app's workers)
//   review/   the round reviews (every move of a round against the bot, judged)
//   remote/   the search and reviews on another machine, which long-polls the server for them
//   host.ts   all of it plugged into a game server's rooms (packages/server's BotDeps and RoomHooks)
export * from './actions.ts';
export * from './belief.ts';
export * from './bot.ts';
export * from './entity.ts';
export * from './env.ts';
export * from './fingerprint.ts';
export * from './history.ts';
export * from './observation.ts';
export * from './observation2.ts';
export * from './policy.ts';
export * from './random.ts';
export * from './worlds.ts';
