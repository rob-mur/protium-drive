@capability:identity
Feature: The binary says which build it is

  A user, and the serving check, can tell which revision a proton-drive-mount binary was
  built from without reading the Nix store.

  @id:binary-reports-its-revision
  Scenario: The binary reports the revision it was built from
    Given the proton-drive-mount binary built from the deployed revision
    When the user asks the binary for its version
    Then the answer names the revision the binary was built from

  @id:a-git-build-gives-its-revision-as-its-version
  Scenario: A build from a git checkout gives its revision in place of a release version
    Given the proton-drive-mount binary built from the deployed revision
    When the user asks the binary for its version
    Then the first line of the answer is the binary's name and the revision it was built from
