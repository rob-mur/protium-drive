@capability:listing-performance
Feature: Listing a large folder loads each node once

  @id:listing-a-large-folder-loads-each-photo-once
  Scenario: Listing a folder of 5000 photos loads each photo's node once
    Given a Drive whose My files holds 5000 photos "Photos/2024/IMG_0001.jpg" to "Photos/2024/IMG_5000.jpg"
    When the user lists "Photos/2024"
    Then the listing shows 5000 files from "IMG_0001.jpg" to "IMG_5000.jpg", and the Drive loaded each of their nodes once

  @id:listing-a-large-folder-again-loads-no-node
  Scenario: Listing the same large folder again loads no node
    Given a Drive whose My files holds 5000 photos "Photos/2024/IMG_0001.jpg" to "Photos/2024/IMG_5000.jpg"
    When the user lists "Photos/2024"
    And the user lists "Photos/2024" again
    Then the last listing shows 5000 files, and the Drive listed "Photos/2024" once and loaded 5000 nodes in all

  @id:reading-a-photo-in-a-listed-folder-lists-no-folder-again
  Scenario: Reading a photo in a folder the serve has listed lists no folder again
    Given a Drive whose My files holds 5000 photos "Photos/2024/IMG_0001.jpg" to "Photos/2024/IMG_5000.jpg"
    When the user lists "Photos/2024"
    And the user reads "Photos/2024/IMG_0042.jpg"
    Then the read gives the photo's content, and the Drive listed "Photos/2024" once

  @id:a-restarted-serve-lists-a-large-folder-without-loading-its-nodes
  Scenario: A restarted serve lists a large folder it listed before without loading its nodes
    Given a Drive whose My files holds 5000 photos "Photos/2024/IMG_0001.jpg" to "Photos/2024/IMG_5000.jpg"
    When the user lists "Photos/2024"
    And the serve restarts
    And the user lists "Photos/2024" again
    Then the last listing shows 5000 files, and the Drive loaded 5000 nodes in all

  @id:writing-into-a-listed-folder-lists-it-no-more
  Scenario: Writing photos into a large folder the serve has listed lists the folder no more
    Given a Drive whose My files holds 5000 photos "Photos/2024/IMG_0001.jpg" to "Photos/2024/IMG_5000.jpg"
    When the user lists "Photos/2024"
    And the user writes "a new photo" to "Photos/2024/NEW_0001.jpg"
    And the user writes "another new photo" to "Photos/2024/NEW_0002.jpg"
    And the user lists "Photos/2024" again
    Then the last listing shows 5002 files, and the Drive listed "Photos/2024" once and loaded 5000 nodes in all
