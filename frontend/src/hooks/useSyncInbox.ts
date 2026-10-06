import { useCallback, useEffect, useState } from 'react';
import type { InboundPackage, SyncLedgerEntry } from '../types/sync';
import { listInbound, listLedger } from '../sync/syncService';

/** 离线核验包收件箱与已应用台账 */
export function useSyncInbox() {
  const [inbox, setInbox] = useState<InboundPackage[]>([]);
  const [ledger, setLedger] = useState<SyncLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [rows, entries] = await Promise.all([listInbound(), listLedger()]);
    setInbox(rows);
    setLedger(entries);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { inbox, ledger, loading, refresh };
}
