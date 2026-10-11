import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{daemon,runners,test}/**/*.test.ts'],
  },
});
