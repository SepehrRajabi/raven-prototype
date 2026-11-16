import { useCallback, useEffect, useRef, useState } from "react";

export interface Loaded<T> {
  /** The last answer that arrived. It is kept while a reload runs and if the reload fails. */
  data: T | null;
  /** Why the latest load failed, empty while it runs or once it succeeds. */
  error: string;
  loading: boolean;
  reload: () => void;
  /** Replace the data with a fresher copy, such as the one a change returned. */
  set: (data: T) => void;
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong. Try again.";
}

/** Loads something when `key` changes and keeps only the newest answer. */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [turn, setTurn] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let current = true;
    // An error belongs to the load that failed; a new attempt starts clean.
    setError("");
    setLoading(true);
    loadRef
      .current()
      .then((result) => {
        if (current) setData(result);
      })
      .catch((cause: unknown) => {
        if (current) setError(errorMessage(cause));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [key, turn]);

  const reload = useCallback(() => setTurn((value) => value + 1), []);
  return { data, error, loading, reload, set: setData };
}
