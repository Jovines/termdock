import React from 'react';
import { MultiTerminalView } from '../lib/components/MultiTerminalView';

interface DemoProps {
  initialCwd?: string;
}

export const MultiSessionDemo: React.FC<DemoProps> = ({ initialCwd = '/' }) => {
  return (
    <div className="h-screen w-full">
      <MultiTerminalView defaultCwd={initialCwd} theme="dark" />
    </div>
  );
};

export default MultiSessionDemo;
