import { writeFileSync } from "node:fs";

export function verifyConditions(_pluginConfig, context) {
  writeFileSync(process.env.CD_RELEASE_BRANCH, context.branch.name);
}

export function publish(_pluginConfig, context) {
  writeFileSync(
    process.env.CD_RELEASE_RECORD,
    JSON.stringify({
      tag: context.nextRelease.gitTag,
      notes: context.nextRelease.notes,
      commits: context.commits.map((commit) => ({
        commit: commit.hash,
        authored_at: commit.author.date,
        committed_at: commit.committer.date,
      })),
    }),
  );
}
