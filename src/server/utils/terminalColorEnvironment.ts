export function buildInteractiveColorEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, COLORTERM: 'truecolor' };
  delete env.NO_COLOR;
  if (source.TERMDOCK_FORCE_COLOR === '1') {
    env.FORCE_COLOR = '1';
  } else {
    delete env.FORCE_COLOR;
  }
  return env;
}

export function buildTmuxColorEnvironmentCommands(
  sessionName?: string,
  forceColor = false,
): string[][] {
  const commands: string[][] = [
    ['set-environment', '-g', 'COLORTERM', 'truecolor'],
    ['set-environment', '-g', '-u', 'NO_COLOR'],
    forceColor
      ? ['set-environment', '-g', 'FORCE_COLOR', '1']
      : ['set-environment', '-g', '-u', 'FORCE_COLOR'],
  ];
  if (sessionName) {
    commands.push(
      ['set-environment', '-t', sessionName, 'COLORTERM', 'truecolor'],
      ['set-environment', '-t', sessionName, '-u', 'NO_COLOR'],
      forceColor
        ? ['set-environment', '-t', sessionName, 'FORCE_COLOR', '1']
        : ['set-environment', '-t', sessionName, '-u', 'FORCE_COLOR'],
    );
  }
  return commands;
}
