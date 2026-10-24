// Keep macOS compiler and SDK discovery in one place for install and repair.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function nativeBuildEnvironment(inherited = process.env, platform = process.platform) {
  const env = { ...inherited };
  if (platform !== 'darwin' || (env.SDKROOT && env.CC && env.CXX)) return env;

  function resolve(command, args, directory) {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 5000 });
    const value = result.stdout?.trim();
    let valid = false;
    if (!result.error && result.status === 0 && value && path.isAbsolute(value)) {
      try {
        valid = directory ? fs.statSync(value).isDirectory() : fs.statSync(value).isFile();
        if (!directory) fs.accessSync(value, fs.constants.X_OK);
      } catch { valid = false; }
    }
    if (!valid) {
      const detail = result.error?.message || result.stderr?.trim() || `exit status=${result.status}; output=${JSON.stringify(value)}`;
      throw new Error(`Cannot resolve macOS native build tools: ${command} ${args.join(' ')} (${detail}). `
        + `DEVELOPER_DIR=${env.DEVELOPER_DIR || '(xcode-select default)'}. `
        + 'Check xcode-select -p and xcrun --sdk macosx --show-sdk-path, or explicitly set matching DEVELOPER_DIR, SDKROOT, CC and CXX for this install.',
      result.error ? { cause: result.error } : undefined);
    }
    return value;
  }

  // Pin the selection for every xcrun query and for node-gyp. Never change the
  // machine-wide xcode-select setting or replace explicit compiler/SDK choices.
  env.DEVELOPER_DIR ||= resolve('/usr/bin/xcode-select', ['-p'], true);
  // The explicit SDK name matters: bare --show-sdk-path can select the CLT SDK
  // even when an older Xcode is selected (nodejs/node-gyp#3344).
  env.SDKROOT ||= resolve('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], true);
  // gyp treats CC/CXX as shell commands, so a discovered path needs quoting
  // when an Xcode directory contains spaces. Explicit commands stay verbatim.
  const compiler = name => {
    const file = resolve('/usr/bin/xcrun', ['--sdk', 'macosx', '--find', name], false);
    return /^[\w/.:+-]+$/.test(file) ? file : `'${file.replaceAll("'", "'\\''")}'`;
  };
  env.CC ||= compiler('clang');
  env.CXX ||= compiler('clang++');
  return env;
}

module.exports = { nativeBuildEnvironment };
