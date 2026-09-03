import { useEffect, useState } from "react";

// Hash routing: the app is served from a static host (GitHub Pages) with no SPA fallback,
// so the room lives in the fragment — `#/r/TOMEK` — and a shared link always resolves.
function current(): string {
  const h = location.hash.replace(/^#/, "");
  return h.startsWith("/") ? h : "/";
}

export function navigate(path: string) {
  location.hash = path;
}

export function usePath(): string {
  const [path, setPath] = useState(current);
  useEffect(() => {
    const onChange = () => setPath(current());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}
