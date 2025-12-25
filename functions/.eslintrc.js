module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  parserOptions: {
    // Set to 2020 or higher to support '??'
    ecmaVersion: 2022,
  },
  rules: {
    "quotes": ["error", "double"],
    "object-curly-spacing": ["error", "always"],
    "indent": ["error", 2],
    "max-len": ["error", { "code": 120 }],
    "new-cap": "off",
    "no-unused-vars": "warn",
    "comma-dangle": ["error", "only-multiline"],
  },
};
