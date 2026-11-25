@capability:argon2-node-keys
Feature: Files whose node key rclone 1.75.0 locked with Argon2

  @id:migrating-a-folder-gives-its-files-v4-node-keys
  Scenario: Migrating a folder re-uploads its Argon2-locked files with v4 node keys
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea" with an Argon2-locked node key
    And the Drive's My files holds the file "Photos/dune.jpg" containing "dry sand" with a v4 node key
    When the user migrates the node keys under "Photos"
    Then "Photos/beach.jpg" contains "sand and sea", has a v4 node key and keeps its modification time
    And the Drive's trash holds the old "beach.jpg"
    And "Photos/dune.jpg" is the same node as before

  @id:a-migration-without-a-folder-shows-the-protium-drive-usage
  Scenario: A node-key migration that names no folder shows how to use it
    When the user starts a node-key migration without naming a folder
    Then the command exits 2 saying "Usage: protium-drive migrate-node-keys FOLDER"
