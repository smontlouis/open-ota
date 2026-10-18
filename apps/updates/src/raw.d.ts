declare module "*?raw" {
  const content: string;
  export default content;
}

// workerd's own cache instance. This project loads the DOM lib as well, whose
// CacheStorage does not declare it.
interface CacheStorage {
  readonly default: Cache;
}
