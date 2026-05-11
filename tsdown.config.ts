import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: false,
  clean: true,
  shims: true,
  banner: {
    js: '#!/usr/bin/env bun'
  }
})
