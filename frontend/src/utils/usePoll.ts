import { useCallback, useEffect, useRef, useState } from "react";

/** Fetch now and every `ms` milliseconds; keeps the last good value if a request fails. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): [T | null, () => void, string | null] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(() => {
    fnRef.current().then((d) => { setData(d); setError(null); }).catch((e) => setError(String(e?.message ?? e)));
  }, []);
  useEffect(() => {
    run();
    const t = setInterval(run, ms);
    return () => clearInterval(t);
  }, [run, ms, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return [data, run, error];
}

export function useLocalFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState<boolean>(() => {
    try { const s = localStorage.getItem(key); return s === null ? initial : s === "1"; } catch { return initial; }
  });
  const set = (nv: boolean) => { setV(nv); try { localStorage.setItem(key, nv ? "1" : "0"); } catch { /* ignore */ } };
  return [v, set];
}
