import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Every <img> shows a page thumbnail made in the browser as a data URL,
      // and the site is a static export, so next/image cannot optimize it.
      "@next/next/no-img-element": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    // Public files include third-party minified PDF and OCR worker bundles.
    "public/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
