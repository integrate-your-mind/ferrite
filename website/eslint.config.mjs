export default [
  {
    ignores: [".ferrite/**", "dist/**"],
  },
  {
    files: ["deploy-adapter.mjs", "tests/**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      eqeqeq: ["error", "always"],
      "no-constant-binary-expression": "error",
      "no-duplicate-imports": "error",
      "no-unused-vars": ["error", { args: "none" }],
    },
  },
];
