import "@testing-library/jest-dom/vitest";

// Node >= 25 defines a global localStorage that is nonfunctional unless the
// process sets --localstorage-file, and vitest's jsdom environment does not
// shadow globals that already exist — so DOM tests inherit the broken stub
// instead of jsdom's Storage. Replace it with a working in-memory version.
// On the pinned node 24 toolchain localStorage is jsdom's own and this is a
// no-op.
if (typeof globalThis.localStorage?.setItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => {
        store.clear();
      },
      getItem: (key: string) => store.get(key) ?? null,
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
    },
  });
}
