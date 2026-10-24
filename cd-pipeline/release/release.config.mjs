// The release toolchain lives here, not in the root package.json, because the root
// package.json is the product's own manifest (rob/continuous-delivery#654).
// release.yml passes this file to semantic-release with --extends, and semantic-release
// resolves a plugin named here from this directory first and from the checkout root second:
// the Gitea plugin from this directory's node_modules, release-record.mjs from the root.
export default {
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "./cd-builtins/release-record.mjs",
    [
      "@saithodev/semantic-release-gitea",
      {
        assets: [{ path: ".ci/release.json", name: "release.json" }],
      },
    ],
  ],
};
