const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || '-';
const runtimeEntitlements = path.resolve(__dirname, 'desktop/entitlements.runtime.plist');
const notarizeConfig = (
  process.env.APPLE_ID
  && process.env.APPLE_APP_SPECIFIC_PASSWORD
  && process.env.APPLE_TEAM_ID
)
  ? {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    }
  : null;

function walkFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function findResourcesDir(buildPath) {
  const candidates = [
    path.join(buildPath, 'Termdock.app', 'Contents', 'Resources'),
    path.join(buildPath, 'Contents', 'Resources'),
    buildPath,
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'runtime', 'bin', 'node'))) {
      return candidate;
    }
  }
  throw new Error(`Could not locate Termdock Resources after packaging: ${buildPath}`);
}

function signBundledRuntime(buildPath, _electronVersion, platform, _arch, callback) {
  try {
    if (platform === 'darwin') {
      const resources = findResourcesDir(buildPath);
      const candidates = [
        path.join(resources, 'runtime', 'bin', 'node'),
        ...walkFiles(path.join(resources, 'toolchain', 'bin')),
        ...walkFiles(path.join(resources, 'toolchain', 'lib')),
        ...walkFiles(path.join(resources, 'server', 'node_modules'))
          .filter((file) => file.endsWith('.node') || path.basename(file) === 'spawn-helper'),
      ];
      for (const binary of candidates) {
        const args = ['--force', '--sign', signingIdentity];
        if (signingIdentity === '-') args.push('--timestamp=none');
        else args.push('--options', 'runtime', '--timestamp');
        if (binary === path.join(resources, 'runtime', 'bin', 'node')) {
          args.push('--entitlements', runtimeEntitlements);
        }
        args.push(binary);
        execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' });
      }
    }
    callback();
  } catch (error) {
    callback(error);
  }
}

function installUniqueMacLauncher(buildPath, _electronVersion, platform, _arch, callback) {
  try {
    if (platform === 'darwin') {
      const appPath = buildPath.endsWith('.app')
        ? buildPath
        : path.join(buildPath, 'Termdock.app');
      const launcherPath = path.join(appPath, 'Contents', 'MacOS', 'Termdock');
      const electronPath = `${launcherPath}.electron`;
      fs.renameSync(launcherPath, electronPath);
      execFileSync('/usr/bin/xcrun', [
        'clang',
        '-Os',
        '-Wall',
        '-Wextra',
        '-o',
        launcherPath,
        path.resolve(__dirname, 'desktop/native/launcher.c'),
      ], { stdio: 'inherit' });
    }
    callback();
  } catch (error) {
    callback(error);
  }
}

function signPackagedApp(buildPath, _electronVersion, platform, _arch, callback) {
  try {
    if (platform === 'darwin') {
      const appPath = buildPath.endsWith('.app')
        ? buildPath
        : path.join(buildPath, 'Termdock.app');
      const args = ['--force', '--deep', '--sign', signingIdentity];
      if (signingIdentity === '-') args.push('--timestamp=none');
      else args.push('--options', 'runtime', '--timestamp');
      args.push(appPath);
      execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' });
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
        stdio: 'inherit',
      });
    }
    callback();
  } catch (error) {
    callback(error);
  }
}

module.exports = {
  packagerConfig: {
    name: 'Termdock',
    executableName: 'Termdock',
    appBundleId: 'com.jovines.termdock',
    appCategoryType: 'public.app-category.developer-tools',
    icon: path.resolve(__dirname, 'desktop/assets/Termdock.icns'),
    extendInfo: {
      NSLocalNetworkUsageDescription:
        'Termdock 需要访问本地网络，以连接你在本机或局域网其他设备上运行的 Termdock 服务。',
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
    },
    extendHelperInfo: {
      NSLocalNetworkUsageDescription:
        'Termdock 需要访问本地网络，以连接你在本机或局域网其他设备上运行的 Termdock 服务。',
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
    },
    asar: true,
    ignore: [
      /^\/\.desktop-runtime($|\/)/,
      /^\/\.git($|\/)/,
      /^\/desktop($|\/)/,
      /^\/dist($|\/)/,
      /^\/docs($|\/)/,
      /^\/node_modules($|\/)/,
      /^\/public($|\/)/,
      /^\/scripts($|\/)/,
      /^\/src($|\/)/,
      /^\/tools($|\/)/,
      /^\/out($|\/)/,
      /^\/(?:README|AGENTS|LICENSE)/,
      /^\/(?:auth-login|install-local|restart-dev|run|uninstall-local)\.sh$/,
      /^\/(?:index\.html|pwa-assets\.config\.ts|postcss\.config\.js|tailwind\.config\.js|tsconfig.*|vite\.config\.ts)$/,
    ],
    extraResource: [
      path.resolve(__dirname, '.desktop-runtime/runtime'),
      path.resolve(__dirname, '.desktop-runtime/server'),
      path.resolve(__dirname, '.desktop-runtime/toolchain'),
      path.resolve(__dirname, '.desktop-runtime/manifest.json'),
      path.resolve(__dirname, 'desktop/cli'),
      path.resolve(__dirname, 'desktop/renderer'),
    ],
    ...(signingIdentity === '-'
      ? {}
      : {
          osxSign: {
            identity: signingIdentity,
            // Executables copied into the main app's Contents/Resources are
            // signed explicitly by signBundledRuntime above. Do not ignore
            // Resources folders inside frameworks: Squirrel's ShipIt helper
            // lives there and must receive Developer ID, timestamp, and runtime.
            ignore: (filePath) => filePath.includes('/Termdock.app/Contents/Resources/'),
          },
          ...(notarizeConfig ? { osxNotarize: notarizeConfig } : {}),
        }),
    afterCopyExtraResources: [installUniqueMacLauncher, signBundledRuntime],
    // @electron/osx-sign must own Developer ID signing so every Electron
    // framework and dylib is re-signed with the same Team ID. The fallback
    // hook remains useful for local ad-hoc builds.
    afterComplete: signingIdentity === '-' ? [signPackagedApp] : [],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: {
        name: 'Termdock',
        format: 'ULFO',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],
};
