import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionCenterServices } from '../../src/components/services/ConnectionCenterServices';

createRoot(document.getElementById('service-manager')!).render(<ConnectionCenterServices bridge={window.termdockDesktop!} />);
