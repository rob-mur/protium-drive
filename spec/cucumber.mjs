// cucumber-js configuration for the frozen suite. Paths are relative to the checkout root,
// which is where the suite runs from:
//
//   bun spec/node_modules/.bin/cucumber-js --config spec/cucumber.mjs --tags '@id:<id>'
//
// Step definitions are anchored regular expressions, never Cucumber Expressions, so the
// `failing_step` regexes in spec/frozen.lock.json are the step definitions' own patterns.
export default {
  paths: ["spec/features/**/*.feature"],
  import: ["spec/steps/**/*.ts", "spec/support/**/*.ts"],
  format: ["progress"],
};
