import { useCallback, useMemo, useRef, useState } from 'react';

/** Keep each session's choice while settings writes are still in flight. */
export function useSessionDeviceSelection(sessionId: string | null, shared: boolean) {
  const [selections, setSelections] = useState(new Map<string | null, { serial: string; loaded: boolean }>());
  const identities = useRef(new Map<string | null, {
    physicalId: { current: string | null };
    edited: { current: boolean };
  }>());
  const identity = useMemo(() => {
    let value = identities.current.get(sessionId);
    if (!value) {
      value = { physicalId: { current: null }, edited: { current: false } };
      identities.current.set(sessionId, value);
    }
    return value;
  }, [sessionId]);
  const setSelectedSerial = useCallback((serial: string) => {
    setSelections(current => new Map(current).set(sessionId, {
      serial, loaded: current.get(sessionId)?.loaded ?? false,
    }));
  }, [sessionId]);
  const setPreferencesLoaded = useCallback((loaded: boolean) => {
    setSelections(current => new Map(current).set(sessionId, {
      serial: current.get(sessionId)?.serial ?? '', loaded,
    }));
  }, [sessionId]);
  return {
    selectedSerial: selections.get(sessionId)?.serial ?? '',
    preferencesLoaded: shared || (selections.get(sessionId)?.loaded ?? false),
    selectedPhysicalId: identity.physicalId,
    selectionEdited: identity.edited,
    setSelectedSerial,
    setPreferencesLoaded,
  };
}
