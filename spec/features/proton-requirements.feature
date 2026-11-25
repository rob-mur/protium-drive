@capability:proton-requirements
Feature: Proton says this build is too old

  Proton can answer each Drive call with the SDK version it requires or suggests, and with the
  features it requires. When they ask for more than this build has, the serve warns the user, and
  tells them to update protium-drive when Proton requires it. Each warning comes once.

  @id:a-required-sdk-update-tells-the-user-to-update
  Scenario: Proton requires a newer SDK, and the serve tells the user to update protium-drive
    Given a Drive whose My files holds the folder "Photos"
    And Proton requires SDK 99.0.0 or newer
    When the user lists "Photos"
    Then the serve warned once "Proton requires SDK 99.0.0 or newer", ending "Update protium-drive."

  @id:a-suggested-sdk-update-warns-without-requiring-an-update
  Scenario: Proton suggests a newer SDK, and the serve says so without requiring an update
    Given a Drive whose My files holds the folder "Photos"
    And Proton suggests SDK 99.0.0 or newer
    When the user lists "Photos"
    Then the serve warned once "Proton suggests SDK 99.0.0 or newer", without "Update protium-drive"

  @id:an-unsupported-drive-feature-tells-the-user-to-update
  Scenario: Proton requires a Drive feature this build lacks, and the serve tells the user to update
    Given a Drive whose My files holds the folder "Photos"
    And Proton requires the drive feature mask 2
    When the user lists "Photos"
    Then the serve warned once "lacks a required feature for drive (mask 2)", ending "Update protium-drive."

  @id:a-requirement-warning-comes-once-however-many-calls-meet-it
  Scenario: The serve warns once of a requirement, however many Drive calls meet it
    Given a Drive whose My files holds the folder "Photos"
    And Proton requires SDK 99.0.0 or newer
    When the user lists "Photos"
    And the user lists "Photos" again
    Then the serve warned once "Proton requires SDK 99.0.0 or newer", though more than one Drive call met the requirement
