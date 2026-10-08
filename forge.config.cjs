const path = require('node:path');
const { execFileSync } = require('node:child_process');

const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || '-';
const macosDeploymentTarget = '12.0';
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
      LSMinimumSystemVersion: macosDeploymentTarget,
      NSUserNotificationAlertStyle: 'banner',
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
      path.resolve(__dirname, 'dist/client'),
      path.resolve(__dirname, 'desktop/renderer'),
    ],
    ...(signingIdentity === '-'
      ? {}
      : {
          osxSign: {
            identity: signingIdentity,
            continueOnError: false,
            ignore: (filePath) => {
              const isSquirrelShipIt = filePath.includes('/Squirrel.framework/')
                && filePath.endsWith('/Resources/ShipIt');
              return filePath.includes('/Resources/') && !isSquirrelShipIt;
            },
          },
          ...(notarizeConfig ? { osxNotarize: notarizeConfig } : {}),
        }),
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
