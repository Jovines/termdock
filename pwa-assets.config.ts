import {
  combinePresetAndAppleSplashScreens,
  defineConfig,
  minimal2023Preset,
} from '@vite-pwa/assets-generator/config';

export default defineConfig({
  headLinkOptions: {
    preset: '2023',
  },
  preset: combinePresetAndAppleSplashScreens({
    ...minimal2023Preset,
    transparent: {
      ...minimal2023Preset.transparent,
      padding: 0,
    },
    maskable: {
      ...minimal2023Preset.maskable,
      padding: 0,
      resizeOptions: {
        background: '#1C1B1A',
        fit: 'contain',
      },
    },
    apple: {
      ...minimal2023Preset.apple,
      padding: 0,
      resizeOptions: {
        background: '#1C1B1A',
        fit: 'contain',
      },
    },
  }, {
    padding: 0.3,
    resizeOptions: {
      background: '#1C1B1A',
      fit: 'contain',
    },
    linkMediaOptions: {
      addMediaScreen: true,
      basePath: '/',
      log: true,
      xhtml: false,
    },
    png: {
      compressionLevel: 9,
      quality: 80,
    },
    name: (landscape, size) =>
      `apple-splash-${landscape ? 'landscape' : 'portrait'}-${size.width}x${size.height}.png`,
  }),
  images: ['public/pwa-512x512.svg'],
});
