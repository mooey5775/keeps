import { PreviewProvider } from './game/Card.tsx';
import { usePath } from './router.ts';
import { Home } from './screens/Home.tsx';
import { Hotseat } from './screens/Hotseat.tsx';
import { Puzzles } from './screens/Puzzles.tsx';
import { RoomScreen } from './screens/RoomScreen.tsx';
import { Sandbox } from './screens/Sandbox.tsx';

export function App() {
  const path = usePath();
  const room = /^\/r\/([A-Za-z]{4})\/?$/.exec(path);
  const puzzle = /^\/puzzles\/?([A-Z]-\d{2})?\/?$/.exec(path);
  const sandbox = /^\/sandbox\/?([a-z-]+)?\/?$/.exec(path);

  let screen;
  if (room) screen = <RoomScreen code={room[1]!.toUpperCase()} />;
  else if (path === '/hotseat') screen = <Hotseat />;
  else if (puzzle) screen = <Puzzles id={puzzle[1] ?? null} />;
  else if (sandbox) screen = <Sandbox name={sandbox[1] ?? null} />;
  else screen = <Home />;

  return <PreviewProvider>{screen}</PreviewProvider>;
}
