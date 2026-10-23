import { createContext, useContext } from 'react';
import type { ShareResources } from '../../server/shared/shareResources';
/** Undefined means the normal service UI; an object is an explicit resource grant. */
export const ShareAccessContext = createContext<ShareResources | undefined>(undefined);
export const useShareAccess = () => useContext(ShareAccessContext);
