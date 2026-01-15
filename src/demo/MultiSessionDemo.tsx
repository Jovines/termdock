import React from 'react';
import { MultiTerminalView } from '../lib/components/MultiTerminalView';

interface DemoProps {
  initialCwd?: string;
}

export const MultiSessionDemo: React.FC<DemoProps> = () => {
  return (
    <div className="h-screen w-full">
      <MultiTerminalView theme="dark" />
    </div>
  );
};

export default MultiSessionDemo;
