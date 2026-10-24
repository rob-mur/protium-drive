@capability:identity
Feature: The binary says which build it is

  A user, and the serving check, can tell which revision a proton-drive-mount binary was
  built from without reading the Nix store.

  @id:binary-reports-its-revision
  Scenario: The binary reports the revision it was built from
    Given the proton-drive-mount binary built from the deployed revision
    When the user asks the binary for its version
    Then the answer names the revision the binary was built from
