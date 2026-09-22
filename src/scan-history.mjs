import { mergeScanMetadata, validateScanMetadata } from "./login-records.mjs";

// Keep failed scan events available for retry while this page remains open.
export function createScanHistoryWriter({ store, recordId, appId, onStatus = () => {} }) {
  const pending = new Map();
  let running;

  async function drain() {
    onStatus({ state: "saving", pending: pending.size });
    while (pending.size) {
      const [key, metadata] = pending.entries().next().value;
      try {
        await store.appendScan(recordId, metadata);
        // An updated callback received during the write still needs saving.
        if (pending.get(key) === metadata) pending.delete(key);
      } catch (error) {
        onStatus({ state: "error", pending: pending.size, error });
        return false;
      }
    }
    onStatus({ state: "saved", pending: 0 });
    return true;
  }

  function retry() {
    if (running) return running;
    if (!pending.size) return Promise.resolve(true);
    running = Promise.resolve().then(drain).finally(() => { running = null; });
    return running;
  }

  return {
    handleEvent(event) {
      // "result" is emitted earlier, including on some SDK failure paths.
      if (event?.options !== "scan-metadata") return Promise.resolve(false);
      let metadata;
      try { metadata = validateScanMetadata(event.value, appId); }
      catch (error) {
        onStatus({ state: "invalid", pending: pending.size, error });
        return Promise.resolve(false);
      }
      const key = JSON.stringify([metadata.appId, metadata.scanId]);
      const previous = pending.get(key);
      pending.set(key, previous ? mergeScanMetadata(previous, metadata) : metadata);
      return retry();
    },
    retry,
    get pendingCount() { return pending.size; },
  };
}
