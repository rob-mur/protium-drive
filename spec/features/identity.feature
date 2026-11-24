@capability:identity
Feature: The binary says which build it is

  A user, and the serving check, can tell which revision a protium-drive binary was
  built from without reading the Nix store.

  @id:binary-reports-its-revision
  Scenario: The binary reports the revision it was built from
    Given the protium-drive binary built from the deployed revision
    When the user asks the binary for its version
    Then the answer names the revision the binary was built from

  @id:a-git-build-gives-protium-drive-and-its-revision-as-its-version
  Scenario: A build from a git checkout gives its name and its revision in place of a release version
    Given the protium-drive binary built from the deployed revision
    When the user asks the binary for its version
    Then the first line of the answer is "protium-drive" and the revision it was built from

  @id:the-package-installs-the-binary-as-protium-drive
  Scenario: The package installs the binary under the name protium-drive
    Given the protium-drive binary built from the deployed revision
    Then the package's bin folder holds the executable "protium-drive"

  @id:the-help-names-protium-drive
  Scenario: The help names the binary protium-drive
    Given the protium-drive binary built from the deployed revision
    When the user asks the binary for its help
    Then the first line of the help names "protium-drive"
