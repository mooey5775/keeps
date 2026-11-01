// Research: training's side of the bot (the Python trainer drives env rounds through server.ts and self-play through
// worker.ts; truth.ts is the true state, for a central critic) and benchmarks against simple players.
export * from './benchmark.ts';
export * from './heuristics.ts';
