import { Home } from "./Home";
import { Room } from "./Room";
import { usePath } from "./router";

export function App() {
  const path = usePath();
  const match = /^\/r\/([A-Za-z0-9]+)\/?$/.exec(path);
  if (match) return <Room key={match[1].toUpperCase()} code={match[1].toUpperCase()} />;
  return <Home />;
}
