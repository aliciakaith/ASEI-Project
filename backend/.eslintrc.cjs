module.exports = {
  env: { es2022: true, node: true },
  extends: ["standard", "plugin:security/recommended"],
  plugins: ["security", "node", "import", "promise"],
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  rules: {
    "security/detect-object-injection": "warn", // noisy at first
    "no-eval": "error",
    "no-new-func": "error"
  },
  ignorePatterns: ["logs/**", "dist/**", "node_modules/**"]
};
